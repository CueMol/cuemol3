// -*-Mode: C++;-*-
//
// FrameRenderPipeline: off-screen multi-pass orchestration for the GTAO AO and
// post-process AA paths.
//

#include <common.h>
#include "FrameRenderPipeline.hpp"
#include "Scene.hpp"
#include "AmbientProbeVolume.hpp"

#include <gfx/DisplayContext.hpp>
#include <gfx/RenderTarget.hpp>
#include <gfx/PostProcGpuPrim.hpp>
#include <gfx/AbstractColor.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace qsys {

namespace {
/// Geometry must stay unchanged this long before the ambient probes are baked
/// (live path; see FrameRenderParams::deferProbeBake).
constexpr double kProbeSettleSec = 0.2;

/// Fast GI tuning, fixed (measured on 2BBV against ChimeraX soft lighting):
/// the occluder thickness the bitmask AO assumes behind each pixel (A; 3 A
/// suits ribbons and CPK alike once the probes carry the large cavities), and the probe bake: grid spacing (A), number of
/// directions and depth tile size (32 / 128 bakes 2BBV in ~14 ms and looks the
/// same as 64 / 256).
constexpr float kFastGIThicknessNear = 3.0f;
constexpr double kProbeSpacing = 3.0;
constexpr int kProbeDirs = 32;
constexpr int kProbeTile = 128;
}  // namespace

namespace {
double nowMs()
{
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}
}  // namespace

FrameRenderPipeline::PassTimer::PassTimer(gfx::DisplayContext *pdc, bool on)
    : m_pdc(pdc), m_bOn(on && pdc != nullptr), m_tPrev(0.0)
{
    if (!m_bOn) return;
    m_tPrev = nowMs();
}

void FrameRenderPipeline::PassTimer::mark(int pass)
{
    if (!m_bOn) return;
    const double t = nowMs();
    m_ms[pass] += t - m_tPrev;
    m_tPrev = t;
}

void FrameRenderPipeline::reportTiming(const PassTimer &timer)
{
    if (!timer.isOn()) {
        // Timing switched off: start the next report from a clean slate.
        m_timingFrames = 0;
        for (double &v : m_timingSum) v = 0.0;
        return;
    }
    for (int i = 0; i < TP_COUNT; ++i) m_timingSum[i] += timer.elapsed(i);
    const double tNow = nowMs();
    if (m_timingLastMs > 0.0 && tNow - m_timingLastMs < 200.0)
        m_timingIntervals.push_back(tNow - m_timingLastMs);
    m_timingLastMs = tNow;
    if (++m_timingFrames < TIMING_REPORT_FRAMES) return;

    const double n = double(m_timingFrames);
    // Median and maximum: a mean would be skewed by the idle gap before a
    // temporal-jitter accumulation starts.
    double median = 0.0, maxIv = 0.0;
    if (!m_timingIntervals.empty()) {
        std::vector<double> iv = m_timingIntervals;
        std::sort(iv.begin(), iv.end());
        median = iv[iv.size() / 2];
        maxIv = iv.back();
    }
    double total = 0.0;
    for (double v : m_timingSum) total += v;
    LOG_DPRINTLN(
        "Render timing (ms, mean of %d frames; CPU submit per pass): scene %.2f, gtao %.2f, "
        "denoise %.2f, "
        "composite %.2f, post-AA/jitter %.2f, total %.2f; frame interval median %.2f max %.2f",
        m_timingFrames, m_timingSum[TP_SCENE] / n, m_timingSum[TP_GTAO] / n,
        m_timingSum[TP_DENOISE] / n, m_timingSum[TP_COMPOSITE] / n,
        m_timingSum[TP_POSTAA] / n, total / n, median, maxIv);
    m_timingIntervals.clear();
    m_timingFrames = 0;
    for (double &v : m_timingSum) v = 0.0;
}

FrameRenderPipeline::~FrameRenderPipeline()
{
    dispose();
}

void FrameRenderPipeline::setSize(gfx::DisplayContext *pdc, int w, int h, bool halfRes,
                                  bool aoEnabled)
{
    if (pdc == nullptr) return;

    // A change of the target set or size leaves the intermediate targets stale
    // for presentLast(); the next render() records a fresh final stage.
    if (m_pAOSceneRT == nullptr || m_pAOSceneRT->getWidth() != w ||
        m_pAOSceneRT->getHeight() != h || m_pAOSceneRT->hasNormal() != aoEnabled) {
        m_lastStage.kind = StageRecord::NONE;
    }

    // The normal attachment (MRT) lets the GTAO pass use real geometry
    // normals instead of depth-reconstructed ones; it exists only for the AO
    // passes. Attachment flags are fixed at creation, so recreate the scene
    // target when the AO requirement changes.
    if (m_pAOSceneRT != nullptr && m_pAOSceneRT->hasNormal() != aoEnabled) {
        delete m_pAOSceneRT;
        m_pAOSceneRT = nullptr;
    }
    if (m_pAOSceneRT == nullptr) {
        createSceneRT(pdc, w, h, aoEnabled);
    } else {
        m_pAOSceneRT->resize(w, h);
    }

    // AO term targets (GTAO + denoise), allocated only while AO is on. Half
    // resolution when requested; the composite edge-aware upsamples them back
    // to full res. resize() is a no-op when unchanged, so toggling halfRes at
    // runtime re-allocates them.
    if (aoEnabled) {
        const int aoW = halfRes ? (w + 1) / 2 : w;
        const int aoH = halfRes ? (h + 1) / 2 : h;
        // A resized AO term (half-res toggle) no longer matches the recorded
        // composite constants.
        if (m_pAoDenRT != nullptr &&
            (m_pAoDenRT->getWidth() != aoW || m_pAoDenRT->getHeight() != aoH)) {
            m_lastStage.kind = StageRecord::NONE;
        }

        // AO targets hold packed data (AO + edges) and must use NEAREST filtering.
        const int aoFlags = gfx::RT_COLOR_RGBA8 | gfx::RT_COLOR_NEAREST;
        // The AO pass target carries a second (float) attachment for the
        // bitmask AO's gathered indirect light (see bounceRT()).
        if (m_pAoRT == nullptr) {
            m_pAoRT = pdc->createRenderTarget(aoW, aoH, aoFlags | gfx::RT_NORMAL_RGBA16F);
        } else {
            m_pAoRT->resize(aoW, aoH);
        }

        if (m_pAoDenRT == nullptr) {
            m_pAoDenRT = pdc->createRenderTarget(aoW, aoH, aoFlags);
        } else {
            m_pAoDenRT->resize(aoW, aoH);
        }
    } else {
        if (m_pAoRT != nullptr) {
            delete m_pAoRT;
            m_pAoRT = nullptr;
        }
        if (m_pAoDenRT != nullptr) {
            delete m_pAoDenRT;
            m_pAoDenRT = nullptr;
        }
    }

    // Composite target for the post-process AA stage. LINEAR filtering (no
    // RT_COLOR_NEAREST) is required for the FXAA sub-texel sampling.
    if (m_pCompRT == nullptr) {
        m_pCompRT = pdc->createRenderTarget(w, h, gfx::RT_COLOR_RGBA8);
    } else {
        m_pCompRT->resize(w, h);
    }

    // SMAA intermediate targets (edges, weights). LINEAR (SMAA relies on
    // bilinear sampling of both). Allocated regardless of the active method;
    // they are cheap RGBA8 buffers and only sampled when aaMethod is smaa.
    if (m_pSmaaEdgeRT == nullptr) {
        m_pSmaaEdgeRT = pdc->createRenderTarget(w, h, gfx::RT_COLOR_RGBA8);
    } else {
        m_pSmaaEdgeRT->resize(w, h);
    }
    if (m_pSmaaWeightRT == nullptr) {
        m_pSmaaWeightRT = pdc->createRenderTarget(w, h, gfx::RT_COLOR_RGBA8);
    } else {
        m_pSmaaWeightRT->resize(w, h);
    }

    // Temporal-jitter targets: per-sample 3D color (RGBA8 LINEAR) and the float
    // accumulation buffer (RGBA16F, to avoid 8-bit banding when summing samples).
    if (m_pJitterSampleRT == nullptr) {
        m_pJitterSampleRT = pdc->createRenderTarget(w, h, gfx::RT_COLOR_RGBA8);
    } else {
        m_pJitterSampleRT->resize(w, h);
    }
    if (m_pJitterAccumRT == nullptr) {
        // The float accumulation target may be refused by a backend without
        // float color attachments; if so, jitter degrades to non-jittered.
        m_pJitterAccumRT = pdc->createRenderTarget(w, h, gfx::RT_COLOR_RGBA16F);
        m_jitterSupported = (m_pJitterAccumRT != nullptr);
    } else {
        m_pJitterAccumRT->resize(w, h);
    }

    if (m_pAOPostProc == nullptr) {
        m_pAOPostProc = MB_NEW gfx::PostProcGpuPrim();
    }
}

void FrameRenderPipeline::createSceneRT(gfx::DisplayContext *pdc, int w, int h,
                                        bool aoEnabled)
{
    int flags = (m_bSceneHdr ? gfx::RT_COLOR_RGBA16F : gfx::RT_COLOR_RGBA8) |
                gfx::RT_DEPTH_TEX;
    if (aoEnabled) flags |= gfx::RT_NORMAL_RGBA16F;
    m_pAOSceneRT = pdc->createRenderTarget(w, h, flags);
}

void FrameRenderPipeline::dispose()
{
    if (m_pProbe != nullptr) {
        delete m_pProbe;
        m_pProbe = nullptr;
    }
    // The render targets and the post-proc primitive's VBO both guard the GL
    // context themselves (via the parent view looked up by ID in their
    // destructors), so do NOT call any display-context method here. dispose() runs
    // from ~GUIView, after the concrete view subclass is already destroyed, where
    // getDisplayContext() would be a pure-virtual call (crash).
    if (m_pAOPostProc != nullptr) {
        delete m_pAOPostProc;
        m_pAOPostProc = nullptr;
    }
    if (m_pJitterAccumRT != nullptr) {
        delete m_pJitterAccumRT;
        m_pJitterAccumRT = nullptr;
    }
    if (m_pJitterSampleRT != nullptr) {
        delete m_pJitterSampleRT;
        m_pJitterSampleRT = nullptr;
    }
    if (m_pSmaaWeightRT != nullptr) {
        delete m_pSmaaWeightRT;
        m_pSmaaWeightRT = nullptr;
    }
    if (m_pSmaaEdgeRT != nullptr) {
        delete m_pSmaaEdgeRT;
        m_pSmaaEdgeRT = nullptr;
    }
    if (m_pCompRT != nullptr) {
        delete m_pCompRT;
        m_pCompRT = nullptr;
    }
    if (m_pAoDenRT != nullptr) {
        delete m_pAoDenRT;
        m_pAoDenRT = nullptr;
    }
    if (m_pAoRT != nullptr) {
        delete m_pAoRT;
        m_pAoRT = nullptr;
    }
    if (m_pAOSceneRT != nullptr) {
        delete m_pAOSceneRT;
        m_pAOSceneRT = nullptr;
    }
    m_jitterSupported = false;
    m_lastStage.kind = StageRecord::NONE;
}

bool FrameRenderPipeline::isReady() const
{
    // The AO term targets are optional (absent in AA-only mode); render()
    // falls back to the no-AO composite when they are missing.
    return m_pAOSceneRT != nullptr && m_pAOPostProc != nullptr;
}

gfx::RenderTarget *FrameRenderPipeline::selectOutRT(const FrameRenderParams &params) const
{
    // While jittering, the final blend lands in the internal per-sample target
    // (accumulated afterwards); otherwise it goes to the caller-supplied target
    // (nullptr = default framebuffer).
    return (params.jitterActive && m_jitterSupported) ? m_pJitterSampleRT
                                                      : params.outRT;
}

int FrameRenderPipeline::getWidth() const
{
    return (m_pAOSceneRT != nullptr) ? m_pAOSceneRT->getWidth() : 0;
}

int FrameRenderPipeline::getHeight() const
{
    return (m_pAOSceneRT != nullptr) ? m_pAOSceneRT->getHeight() : 0;
}

bool FrameRenderPipeline::hasCachedStage() const
{
    if (!isReady()) return false;
    if (m_lastStage.aoActive && m_pAoDenRT == nullptr) return false;
    switch (m_lastStage.kind) {
        case StageRecord::COMPOSITE:
            return true;
        case StageRecord::FXAA:
            return m_pCompRT != nullptr;
        case StageRecord::SMAA:
            return m_pCompRT != nullptr && m_pSmaaWeightRT != nullptr;
        case StageRecord::JITTER:
            return m_pJitterAccumRT != nullptr && m_jitterSupported;
        default:
            return false;
    }
}

void FrameRenderPipeline::presentStage(gfx::DisplayContext *pdc, const StageRecord &st)
{
    // Same AO source as render(): the raw GTAO buffer for its normal / depth
    // debug images, otherwise the denoised term.
    gfx::RenderTarget *pAoDen =
        !st.aoActive ? nullptr : (st.aoc.debugView == 2) ? m_pAoRT : m_pAoDenRT;
    switch (st.kind) {
        case StageRecord::COMPOSITE:
            m_pAOPostProc->drawComposite(pdc, m_pAOSceneRT, pAoDen, st.aoc, bounceRT(st.aoc, st.aoActive));
            break;
        case StageRecord::FXAA:
            m_pAOPostProc->drawFxaa(pdc, m_pCompRT, st.aoc);
            break;
        case StageRecord::SMAA:
            m_pAOPostProc->drawSmaaBlend(pdc, m_pCompRT, m_pSmaaWeightRT, st.aoc);
            break;
        case StageRecord::JITTER:
            m_pAOPostProc->drawJitterCompose(pdc, m_pJitterAccumRT, st.dispWeight);
            break;
        default:
            break;
    }
}

bool FrameRenderPipeline::presentLast(gfx::DisplayContext *pdc)
{
    if (pdc == nullptr || !hasCachedStage()) return false;

    // Same state as the live path's final stage: the fullscreen pass replaces
    // the pixels of the bound (default) framebuffer.
    pdc->setDepthTestEnabled(false);
    pdc->setBlendEnabled(false);
    presentStage(pdc, m_lastStage);
    pdc->setBlendEnabled(true);
    pdc->setDepthTestEnabled(true);

    if (m_lastStage.blitDepth) m_pAOSceneRT->blitDepthToDefault();
    return true;
}

const gfx::AoProbeParams *FrameRenderPipeline::prepareProbes(gfx::DisplayContext *pdc,
                                                             const ScenePtr &pScene,
                                                             int aoMethod,
                                                             const qlib::Matrix4D &modelView,
                                                             bool deferBake,
                                                             gfx::AoProbeParams &probe)
{
    m_bProbePending = false;
    m_bProbeBaked = false;
    if (!(aoMethod == Scene::AOM_FASTGI && pScene->getAOProbeStrength() > 0.0)) return nullptr;

    if (m_pProbe == nullptr) m_pProbe = MB_NEW AmbientProbeVolume();
    const unsigned int prevBakes = m_pProbe->getBakeCount();
    const bool ok = m_pProbe->update(pdc, pScene, kProbeSpacing, m_pAOPostProc, kProbeDirs,
                                     kProbeTile, deferBake ? kProbeSettleSec : 0.0,
                                     &m_bProbePending);
    m_bProbeBaked = (m_pProbe->getBakeCount() != prevBakes);
    if (!ok) return nullptr;

    // GTAO view space has viewZ > 0 forward; the eye space looks down -Z.
    qlib::Matrix4D flipZ;
    flipZ.aij(3, 3) = -1.0;
    probe.atlas = m_pProbe->getAtlas();
    for (int a = 0; a < 3; ++a) probe.dim[a] = m_pProbe->getDim()[a];
    probe.spacing = m_pProbe->getSpacing();
    probe.viewToWorld = qlib::Matrix4D(modelView.invert() * flipZ);
    for (int a = 0; a < 3; ++a) probe.origin[a] = m_pProbe->getOrigin()[a];
    // Look the probes up one cell out along the normal: half a cell
    // interpolates the probes inside a thin solid (a 4.6 A cartoon cylinder)
    // into blotches; further out the lookup reaches past a silhouette into the
    // neighbours.
    probe.bias = m_pProbe->getSpacing();
    probe.strength = float(pScene->getAOProbeStrength());
    // Soft shadow of the key light from the same probes.
    for (int a = 0; a < 3; ++a) probe.lightDir[a] = Scene::kLightDir[a];
    probe.keyShadow = 1.0f;
    probe.keyShadowPower = float(Scene::kFastGIKeyShadowPower);
    return &probe;
}

bool FrameRenderPipeline::render(gfx::DisplayContext *pdc, const ScenePtr &pScene,
                                 const FrameRenderParams &params,
                                 const std::function<void()> &sceneRenderFn)
{
    if (!isReady()) return false;

    const bool jitter = params.jitterActive && m_jitterSupported;
    // AA-only mode skips the GTAO/denoise passes and composites without an AO
    // term. The RT guards also cover the case where the AO targets were not
    // allocated (setSize with aoEnabled=false).
    const bool aoActive =
        params.enableAO && m_pAoRT != nullptr && m_pAoDenRT != nullptr;

    // 1. Render the 3D scene into the off-screen target (color + depth + MRT
    // normal). The clear precedes the scene callback; the model-matrix setup the
    // callback performs is independent of the clear, so the result is identical to
    // clearing after it.
    // The bitmask AO (aoMethod 1) applies the occlusion to the ambient light
    // only, which needs the lit colour before clamping: render the scene into
    // a float target with the lighting clamp off (the composite clamps).
    const bool hdr = aoActive && pScene->getAOMethod() == Scene::AOM_FASTGI;
    if (hdr != m_bSceneHdr) {
        m_bSceneHdr = hdr;
        const int w = m_pAOSceneRT->getWidth();
        const int h = m_pAOSceneRT->getHeight();
        const bool hasNormal = m_pAOSceneRT->hasNormal();
        delete m_pAOSceneRT;
        m_pAOSceneRT = nullptr;
        createSceneRT(pdc, w, h, hasNormal);
        m_lastStage.kind = StageRecord::NONE;
        if (m_pAOSceneRT == nullptr) return false;
    }

        PassTimer timer(pdc, pScene->isRenderTiming());
    gfx::ColorPtr bg = pScene->getBgColor();
    const float bgA = params.bgTransparent ? 0.0f : 1.0f;
    m_pAOSceneRT->bind();
    m_pAOSceneRT->clear(float(bg->fr()), float(bg->fg()), float(bg->fb()), bgA);
    pdc->setLightNoClamp(m_bSceneHdr);
    sceneRenderFn();
    pdc->setLightNoClamp(false);
    // Camera modelview the scene was drawn with (world -> eye), for the probe
    // lookup's view -> world reconstruction.
    const qlib::Matrix4D modelView = pdc->getModelViewMat();
    m_pAOSceneRT->unbind();
    timer.mark(TP_SCENE);

    // AO debug view: the GTAO pass's own normal / depth images bypass the
    // denoise (shown as is), the AO view shows the denoised term in gray.
    const int aoDebug = aoActive ? pScene->getAODebugView() : int(Scene::AODV_OFF);
    const int gtaoDebug = (aoDebug == Scene::AODV_NORMAL) ? 1
                          : (aoDebug == Scene::AODV_DEPTH) ? 2
                                                           : 0;

    // 2. AO constants: camera part from params, AO tuning read from the Scene.
    gfx::AoConstants aoc = params.camAoc;
    // SMAA tuning (used by the post-AA stage, independent of AO).
    aoc.smaaThreshold = float(pScene->getAASmaaThreshold());
    aoc.debugView = (gtaoDebug != 0)                         ? 2
                    : (aoDebug == Scene::AODV_AO)             ? 1
                                                              : 0;
    if (aoActive) {
        aoc.effectRadius = float(pScene->getAORadius());
        aoc.finalValuePower = float(pScene->getAOIntensity());
        aoc.sliceCount = pScene->getAOSlices();
        aoc.stepsPerSlice = pScene->getAOSteps();
        aoc.aoMethod = pScene->getAOMethod();
        // Bitmask, still view: each temporal-jitter sample computes only 2
        // slices with the noise rotated per sample, and the accumulation
        // averages them; 8 samples of 2
        // slices look the same as 8 slices. A full-resolution frame of 8
        // slices costs ~45 ms when atoms fill a zoomed-in view.
        if (aoc.aoMethod == Scene::AOM_FASTGI && params.jitterActive && aoc.sliceCount > 2)
            aoc.sliceCount = 2;
        aoc.thicknessNear = kFastGIThicknessNear;
        aoc.bounceStrength =
            (aoc.aoMethod == Scene::AOM_FASTGI) ? float(std::max(0.0, pScene->getAOBounce()))
                                                 : 0.0f;
        // The lit colour's intensities (Scene::display), so the composite can
        // split it into its ambient, diffuse and specular parts.
        const float bri = float(std::max(0.0, pScene->getLightBrightness()));
        aoc.lightAmbient = float(Scene::kFastGILightAmbient) * bri;
        aoc.lightDiffuse = float(Scene::kFastGILightDiffuse) * bri;
        for (int a = 0; a < 3; ++a) aoc.lightDir[a] = Scene::kLightDir[a];
        aoc.specOcclusion = true;
        aoc.keyShadow = true;
        aoc.aoNoiseOffset = params.aoNoiseOffset;
        // AO buffer texel size (= full res, or 2x coarser at half res). The GTAO /
        // denoise passes run at this resolution, so they use it as their pixel size;
        // the composite reads both to know whether (and how) to upsample.
        aoc.aoTexelSize[0] = 1.0f / float(m_pAoRT->getWidth());
        aoc.aoTexelSize[1] = 1.0f / float(m_pAoRT->getHeight());
        // Fog parameters for the composite's AO fade. These must match the scene's
        // setupFog (ShaderObject::setupFog): fogScale = 1/(fogEnd - fogStart). The
        // composite recomputes the same linear fog factor from the scene depth and
        // fades the AO term out where fog has taken over, so fully-fogged pixels are
        // not darkened by AO.
        const double fogStart = pdc->getFogStart();
        const double fogEnd = pdc->getFogEnd();
        aoc.fogEnd = float(fogEnd);
        pdc->getDevRGBColor(pdc->getFogColor(), aoc.fogColor[0], aoc.fogColor[1],
                            aoc.fogColor[2]);
        aoc.fogScale = (fogEnd > fogStart) ? float(1.0 / (fogEnd - fogStart)) : 0.0f;
        gfx::AoConstants aocAO = aoc;
        aocAO.fullPixelSize[0] = aoc.viewportPixelSize[0];
        aocAO.fullPixelSize[1] = aoc.viewportPixelSize[1];
        aocAO.viewportPixelSize[0] = aoc.aoTexelSize[0];
        aocAO.viewportPixelSize[1] = aoc.aoTexelSize[1];
        // Keep the horizon-radius cap at a fixed full-res-equivalent value so half
        // res yields the same occlusion as full res.
        // The bitmask AO caps its march with the same value.
        aocAO.maxScreenspaceRadius =
            256.0f * (aoc.viewportPixelSize[0] / aoc.aoTexelSize[0]);

        // Bitmask AO: baked world-space ambient probes (AmbientProbeVolume).
        // Updated before the AO target is bound: a (re)bake binds its own
        // targets and unbinding them returns to the default framebuffer.
        gfx::AoProbeParams probe;
        const gfx::AoProbeParams *pProbe = prepareProbes(
            pdc, pScene, aoc.aoMethod, modelView, params.deferProbeBake, probe);

        // 3. GTAO pass: read the scene depth, write AO + packed edges.
        m_pAoRT->bind();
        m_pAoRT->clear(1.0f, 1.0f, 1.0f, 1.0f);
        m_pAOPostProc->drawGtao(pdc, m_pAOSceneRT, aocAO, gtaoDebug, pProbe);
        m_pAoRT->unbind();
        timer.mark(TP_GTAO);

        // 4. Edge-aware denoise of the AO term (single pass).
        m_pAoDenRT->bind();
        m_pAOPostProc->drawDenoise(pdc, m_pAoRT, aocAO);
        m_pAoDenRT->unbind();
        timer.mark(TP_DENOISE);

    } else {
        // AA-only: keep the AO texel size equal to the viewport so the
        // composite's upsample check stays off. The composite shader reads no
        // other AO uniforms when u_hasAO == 0 (plain copy).
        aoc.aoTexelSize[0] = aoc.viewportPixelSize[0];
        aoc.aoTexelSize[1] = aoc.viewportPixelSize[1];
    }

    gfx::RenderTarget *outRT = selectOutRT(params);
    // The composite multiplies the denoised AO term, or plain-copies the scene
    // color when the AO passes did not run (nullptr -> u_hasAO == 0).
    gfx::RenderTarget *pAoDen =
        !aoActive ? nullptr : (gtaoDebug != 0) ? m_pAoRT : m_pAoDenRT;

    if (params.enablePostAA) {
        // ---- Live path: composite scene color * denoised AO, then the selected
        // post-process AA, then optional temporal-jitter accumulate/display. The
        // final stage goes through presentStage() and is recorded, so
        // presentLast() can replay it for a present-only frame. ----
        const int aaMethod = pScene->getAAMethod();
        const bool postAA = (aaMethod == Scene::AA_FXAA ||
                             aaMethod == Scene::AA_SMAA) &&
                            m_pCompRT != nullptr;
        StageRecord st;
        st.aoc = aoc;
        st.aoActive = aoActive;
        st.blitDepth = params.blitDepthToDefault;

        // The fullscreen passes replace pixels. The post-AA passes write data
        // (SMAA edges have alpha 0, the weights' alpha carries data); with
        // GL_BLEND on their output would be discarded.
        pdc->setDepthTestEnabled(false);
        pdc->setBlendEnabled(false);
        if (postAA) {
            m_pCompRT->bind();
            m_pAOPostProc->drawComposite(pdc, m_pAOSceneRT, pAoDen, aoc, bounceRT(aoc, aoActive));
            m_pCompRT->unbind();
            timer.mark(TP_COMPOSITE);

            if (aaMethod == Scene::AA_SMAA && m_pSmaaEdgeRT != nullptr &&
                m_pSmaaWeightRT != nullptr) {
                // 1. Edge detection (cleared so non-edge pixels read 0).
                m_pSmaaEdgeRT->bind();
                m_pSmaaEdgeRT->clear(0.0f, 0.0f, 0.0f, 0.0f);
                m_pAOPostProc->drawSmaaEdges(pdc, m_pCompRT, aoc);
                m_pSmaaEdgeRT->unbind();
                // 2. Blending weight calculation.
                m_pSmaaWeightRT->bind();
                m_pSmaaWeightRT->clear(0.0f, 0.0f, 0.0f, 0.0f);
                m_pAOPostProc->drawSmaaWeights(pdc, m_pSmaaEdgeRT, aoc);
                m_pSmaaWeightRT->unbind();
                // 3. Neighborhood blending is the final stage.
                st.kind = StageRecord::SMAA;
            } else {
                st.kind = StageRecord::FXAA;
            }
        } else {
            st.kind = StageRecord::COMPOSITE;
        }

        // Final stage of this sample -> outRT (jitter sample target / caller
        // target) or the default framebuffer.
        if (outRT != nullptr) outRT->bind();
        presentStage(pdc, st);
        if (outRT != nullptr) outRT->unbind();
        // Without post-AA the final stage is the composite itself.
        timer.mark(postAA ? TP_POSTAA : TP_COMPOSITE);

        // Temporal-jitter accumulate + display. The final color of this sample is
        // in m_pJitterSampleRT.
        if (jitter) {
            const float invN = 1.0f / float(params.jitterCount);
            // Additive sum into the float accumulation buffer (cleared on the
            // first sample).
            m_pJitterAccumRT->bind();
            if (params.jitterIndex == 0)
                m_pJitterAccumRT->clear(0.0f, 0.0f, 0.0f, 0.0f);
            pdc->setBlendEnabled(true);
            pdc->setBlendModeAdd(true);
            m_pAOPostProc->drawJitterCompose(pdc, m_pJitterSampleRT, invN);
            pdc->setBlendModeAdd(false);
            pdc->setBlendEnabled(false);
            m_pJitterAccumRT->unbind();

            // Display the normalized partial average to the default framebuffer;
            // this display is the stage a present-only frame replays.
            st.kind = StageRecord::JITTER;
            st.dispWeight = float(params.jitterCount) / float(params.jitterIndex + 1);
            presentStage(pdc, st);
            timer.mark(TP_POSTAA);
        }
        // Restore over-blend / depth test for the UI overlay drawn afterwards.
        pdc->setBlendEnabled(true);
        pdc->setDepthTestEnabled(true);

        // Restore the scene depth into the default framebuffer so the UI overlays
        // depth-test against the scene as usual.
        if (params.blitDepthToDefault) m_pAOSceneRT->blitDepthToDefault();

        m_lastStage = st;
    } else {
        // ---- Exporter path: composite only (color * AO, edge-aware upsampled
        // when half res) -> outRT. No spatial post-AA. Blend off so the
        // fullscreen pass replaces (transparent-bg pixels keep alpha 0). ----
        pdc->setDepthTestEnabled(false);
        pdc->setBlendEnabled(false);
        if (outRT != nullptr) outRT->bind();
        m_pAOPostProc->drawComposite(pdc, m_pAOSceneRT, pAoDen, aoc, bounceRT(aoc, aoActive));
        if (outRT != nullptr) outRT->unbind();
        timer.mark(TP_COMPOSITE);
        pdc->setBlendEnabled(true);
        pdc->setDepthTestEnabled(true);
    }

    reportTiming(timer);
    return true;
}

}  // namespace qsys
