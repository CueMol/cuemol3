// -*-Mode: C++;-*-
//
// AmbientProbeVolume: baked world-space ambient visibility probes (PoC).
//

#include <common.h>

#include "AmbientProbeVolume.hpp"

#include "Object.hpp"
#include "Renderer.hpp"
#include "Scene.hpp"

#include <gfx/DisplayContext.hpp>
#include <gfx/PostProcGpuPrim.hpp>
#include <gfx/RenderTarget.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>

namespace qsys {

AmbientProbeVolume::~AmbientProbeVolume()
{
    release();
}

void AmbientProbeVolume::release()
{
    releaseTargets();
    // Bake again on the next update.
    m_bKeyValid = false;
    m_bPending = false;
}

void AmbientProbeVolume::releaseTargets()
{
    if (m_pDepthAtlas != nullptr) {
        delete m_pDepthAtlas;
        m_pDepthAtlas = nullptr;
    }
    for (auto &p : m_pProbeRT) {
        if (p != nullptr) {
            delete p;
            p = nullptr;
        }
    }
    m_nResultRT = -1;
}

gfx::RenderTarget *AmbientProbeVolume::getAtlas() const
{
    return (m_nResultRT >= 0) ? m_pProbeRT[m_nResultRT] : nullptr;
}

namespace {

void collectSpheres(const ScenePtr &pScene, std::vector<qlib::Vector4D> &sph)
{
    for (auto oi = pScene->beginObj(); oi != pScene->endObj(); ++oi) {
        ObjectPtr pObj = oi->second;
        if (pObj.isnull() || !pObj->isVisible()) continue;
        for (auto ri = pObj->beginRend(); ri != pObj->endRend(); ++ri) {
            RendererPtr pRend = ri->second;
            if (pRend.isnull() || !pRend->isVisible()) continue;
            // A translucent renderer (a veil) occludes nothing: as in the ray
            // tracer, it casts no shadow or AO on what it covers.
            if (pRend->getDefaultAlpha() < 1.0 - Scene::kVeilAlphaEps) continue;
            pRend->collectOcclusionSpheres(sph);
        }
    }
}

/// The probe direction set: must match probe_bake_frag.glsl (probeDir).
void probeDir(int k, int nd, double d[3])
{
    const double z = 1.0 - (k + 0.5) * 2.0 / nd;
    const double r = std::sqrt(std::max(0.0, 1.0 - z * z));
    const double phi = k * 2.399963229728653;
    d[0] = r * std::cos(phi);
    d[1] = r * std::sin(phi);
    d[2] = z;
}

}  // namespace

bool AmbientProbeVolume::update(gfx::DisplayContext *pdc, const ScenePtr &pScene,
                                double spacing, gfx::PostProcGpuPrim *pPostProc, int numDirs,
                                int tileSize, double settleSec, bool *pPending)
{
    if (pPending != nullptr) *pPending = false;
    if (pPostProc == nullptr) return false;
    // The baked probes depend on the scene geometry, which the scene's
    // occluder generation follows (a camera move leaves it alone, so the
    // live path does nothing per frame), and on the bake settings.
    const unsigned int gen = pScene->getOccluderGen();
    const double settings = spacing * 7.31 + numDirs * 0.013 + tileSize * 0.0071;
    if (m_bKeyValid && gen == m_bakedGen && settings == m_bakedSettings)
        return getAtlas() != nullptr;
    const double now = std::chrono::duration<double>(
                           std::chrono::steady_clock::now().time_since_epoch())
                           .count();
    if (settleSec > 0.0) {
        // The geometry changed: draw without the probes until it has stayed
        // the same for settleSec, then bake once.
        if (!m_bPending || gen != m_pendingGen) {
            m_bPending = true;
            m_pendingGen = gen;
            m_pendingSince = now;
        }
        if (now - m_pendingSince < settleSec) {
            if (pPending != nullptr) *pPending = true;
            return false;
        }
    }
    m_bPending = false;
    m_bKeyValid = true;
    m_bakedGen = gen;
    m_bakedSettings = settings;

    // The occluder spheres give the grid bounds. Collecting them evaluates
    // every renderer's selection over its atoms (~60 ms for the 5 default
    // renderers of a 59k-atom structure), so it runs only here, once per bake.
    const auto t0 = std::chrono::steady_clock::now();
    std::vector<qlib::Vector4D> sph;
    collectSpheres(pScene, sph);
    if (sph.empty()) {
        // Nothing to bake; stays so until the geometry changes.
        releaseTargets();
        return false;
    }
    const double collectMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    // Grid placement: the bounds of the spheres plus 2 probes.
    const double h = spacing;
    const int PAD = 2;
    double lo[3] = {1e30, 1e30, 1e30}, hi[3] = {-1e30, -1e30, -1e30};
    for (const auto &v : sph) {
        for (int a = 0; a < 3; ++a) {
            lo[a] = std::min(lo[a], v.ai(a + 1) - v.w());
            hi[a] = std::max(hi[a], v.ai(a + 1) + v.w());
        }
    }
    gfx::ProbeBakeParams bp;
    double rad2 = 0.0;
    for (int a = 0; a < 3; ++a) {
        m_dim[a] = int(std::ceil((hi[a] - lo[a]) / h)) + 2 * PAD;
        bp.dim[a] = m_dim[a];
        bp.origin[a] = float(lo[a] - PAD * h);
        m_origin[a] = bp.origin[a];
        bp.center[a] = float(0.5 * (lo[a] + hi[a]));
        rad2 += 0.25 * (hi[a] - lo[a]) * (hi[a] - lo[a]);
    }
    m_spacing = float(h);
    // Each light view covers the bounding sphere of the occluders' box.
    const double R = std::sqrt(rad2) + 2.0;
    const double L = R + 2.0;
    const double nearZ = 1.0, farZ = L + R + 1.0;
    bp.radius = float(R);
    bp.camDist = float(L);
    bp.nearFar[0] = float(nearZ);
    bp.nearFar[1] = float(farZ);
    bp.spacing = float(h);
    bp.depthBias = float(0.3 / (farZ - nearZ));
    const int ND = std::max(1, std::min(64, numDirs));
    bp.numDirs = ND;
    bp.tilesPerRow = 8;
    bp.tileSize = tileSize;
    const int A = bp.tileSize * bp.tilesPerRow;

    if (m_pDepthAtlas != nullptr && m_pDepthAtlas->getWidth() != A) m_pDepthAtlas->resize(A, A);
    if (m_pDepthAtlas == nullptr)
        m_pDepthAtlas = pdc->createRenderTarget(A, A, gfx::RT_COLOR_RGBA8 | gfx::RT_DEPTH_TEX);
    // Atlas layout: probe (x, y, z) is texel (x + z * nx, y), the z slices side
    // by side. Assumed as well by probe_bake_frag.glsl / probe_fill_frag.glsl
    // (integer texel <-> probe) and gtao_frag.glsl sampleProbeGrid (filtered
    // lookup, z split into two slices); change them together.
    const int aw = m_dim[0] * m_dim[2], ah = m_dim[1];
    // LINEAR: the AO pass reads the atlas with bilinear filtering within a
    // slice (the bake / fill passes use texelFetch, which ignores the filter).
    for (auto &rt : m_pProbeRT) {
        if (rt == nullptr)
            rt = pdc->createRenderTarget(aw, ah, gfx::RT_COLOR_RGBA16F);
        else
            rt->resize(aw, ah);
    }
    if (m_pDepthAtlas == nullptr || m_pProbeRT[0] == nullptr || m_pProbeRT[1] == nullptr) {
        releaseTargets();
        return false;
    }

    // 1. Depth of the scene from every probe direction (orthographic views
    // looking at the centre from distance L), one atlas tile each.
    const qlib::Matrix4D savedProj = pdc->getProjMat();
    const qlib::Vector4D savedVp = pdc->getViewport();
    m_pDepthAtlas->bind();
    m_pDepthAtlas->clear(1.0f, 1.0f, 1.0f, 1.0f);
    pdc->setDepthTestEnabled(true);
    pdc->setProjMat(gfx::DisplayContext::makeOrthoProjMat(float(-R), float(R), float(-R),
                                                          float(R), float(nearZ), float(farZ)));
    for (int k = 0; k < ND; ++k) {
        double d[3];
        probeDir(k, ND, d);
        // Basis: must match probe_bake_frag.glsl.
        const double up[3] = {std::abs(d[2]) < 0.9 ? 0.0 : 1.0, 0.0,
                              std::abs(d[2]) < 0.9 ? 1.0 : 0.0};
        double r[3] = {up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2],
                       up[0] * d[1] - up[1] * d[0]};
        const double rl = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        for (double &x : r) x /= rl;
        const double u[3] = {d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2],
                             d[0] * r[1] - d[1] * r[0]};
        const double E[3] = {bp.center[0] + d[0] * L, bp.center[1] + d[1] * L,
                             bp.center[2] + d[2] * L};
        qlib::Matrix4D V;
        const double *rows[3] = {r, u, d};
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) V.aij(i + 1, j + 1) = rows[i][j];
            V.aij(i + 1, 4) = -(rows[i][0] * E[0] + rows[i][1] * E[1] + rows[i][2] * E[2]);
        }
        pdc->loadMatrix(V);
        const int tx = k % bp.tilesPerRow, ty = k / bp.tilesPerRow;
        pdc->setViewport(qlib::Vector4D(tx * bp.tileSize, ty * bp.tileSize, bp.tileSize,
                                        bp.tileSize));
        // Without the translucent renderers (veils), as the occluder spheres.
        Scene::DrawFilter df;
        df.kind = Scene::DrawFilter::DF_BACKGROUND;
        Scene::AutoDrawFilter adf(pScene.get(), df);
        pScene->display(pdc);
    }
    m_pDepthAtlas->unbind();
    pdc->setProjMat(savedProj);
    pdc->setViewport(savedVp);

    // 2. All probes against the 64 depth views, then fill the probes inside
    // atoms (ping-pong).
    pdc->setDepthTestEnabled(false);
    pdc->setBlendEnabled(false);
    m_pProbeRT[0]->bind();
    pPostProc->drawProbeBake(pdc, m_pDepthAtlas, bp);
    m_pProbeRT[0]->unbind();
    int cur = 0;
    for (int pass = 0; pass < 6; ++pass) {
        m_pProbeRT[1 - cur]->bind();
        pPostProc->drawProbeFill(pdc, m_pProbeRT[cur], bp);
        m_pProbeRT[1 - cur]->unbind();
        cur = 1 - cur;
    }
    pdc->setBlendEnabled(true);
    pdc->setDepthTestEnabled(true);
    m_nResultRT = cur;
    ++m_nBakeCount;

    const double ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    LOG_DPRINTLN("AO probes (GPU, %s): %d spheres (collected in %.0f ms), %dx%dx%d probes of "
                 "%.1f A, baked in %.0f ms (CPU side, GPU not awaited)",
                 settleSec > 0.0 ? "live" : "export", int(sph.size()), collectMs, m_dim[0],
                 m_dim[1], m_dim[2], spacing, ms);
    return true;
}

}  // namespace qsys
