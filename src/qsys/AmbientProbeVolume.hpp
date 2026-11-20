// -*-Mode: C++;-*-
//
// AmbientProbeVolume: baked world-space ambient visibility probes.
//
// Precomputed occlusion of a uniform ambient light (the role a volume light
// probe plays in a game engine or in Blender): a 3D grid of probes, each storing the visibility of
// the surrounding sphere of directions as an L1 spherical-harmonic-like moment
// pair: m0 = mean visibility, m1 = mean(visibility * direction). It is baked on
// the GPU from depth views of the scene's own renderers (so everything drawn
// occludes). The shading side evaluates the cosine-weighted visibility around
// a normal N as clamp(m0 + 2 * dot(m1, N), 0, 1) (1 when unoccluded, 1 for a
// flat open surface). The grid is rebaked only when the scene geometry changes
// (Scene::getOccluderGen); it spans the occluder spheres the renderers report
// (Renderer::collectOcclusionSpheres).
//

#pragma once

#include "qsys.hpp"

#include <qlib/Vector4D.hpp>

#include <vector>

namespace gfx {
class DisplayContext;
class RenderTarget;
class PostProcGpuPrim;
}  // namespace gfx

namespace qsys {

class QSYS_API AmbientProbeVolume
{
public:
    AmbientProbeVolume() = default;
    ~AmbientProbeVolume();

    /// Bake when the scene geometry (or the bake settings) changed, as Blender
    /// bakes its volume probes: render the scene depth from numDirs probe
    /// directions into the tiles of a depth atlas, evaluate all probes in one
    /// fullscreen pass and fill the probes inside atoms. The grid spans the
    /// occluder spheres; the result is a 2D atlas (z slices side by side,
    /// getAtlas()). Restores the display context's projection and viewport.
    /// Returns true when baked probes are available.
    ///
    /// settleSec > 0 defers the bake while the geometry keeps changing (as the
    /// temporal-jitter AA defers its accumulation): a change is baked only
    /// once no further change has come for settleSec; until then this
    /// returns false (draw without the probes) and *pPending is set, so the
    /// caller keeps redrawing. settleSec == 0 bakes at once (image export).
    bool update(gfx::DisplayContext *pdc, const ScenePtr &pScene, double spacing,
                gfx::PostProcGpuPrim *pPostProc, int numDirs = 32, int tileSize = 128,
                double settleSec = 0.0, bool *pPending = nullptr);

    /// Release the render targets; the next update bakes again.
    void release();

    /// The baked probes (nullptr before the first bake).
    gfx::RenderTarget *getAtlas() const;
    const int *getDim() const { return m_dim; }
    /// World position of the grid corner (texel 0 edge).
    const float *getOrigin() const { return m_origin; }
    float getSpacing() const { return m_spacing; }
    /// Number of bakes so far (a change tells that the probes were rebaked).
    unsigned int getBakeCount() const { return m_nBakeCount; }

private:
    /// Release the render targets, keeping what they were baked from.
    void releaseTargets();

    gfx::RenderTarget *m_pDepthAtlas = nullptr;
    gfx::RenderTarget *m_pProbeRT[2] = {nullptr, nullptr};
    int m_nResultRT = -1;
    int m_dim[3] = {1, 1, 1};
    float m_origin[3] = {0, 0, 0};
    float m_spacing = 1.0f;
    unsigned int m_nBakeCount = 0;
    /// What the current probes were baked from (Scene::getOccluderGen and the
    /// bake settings); m_bKeyValid is false before the first bake.
    bool m_bKeyValid = false;
    unsigned int m_bakedGen = 0;
    double m_bakedSettings = 0.0;
    /// Deferred bake: the generation waiting to settle and since when.
    bool m_bPending = false;
    unsigned int m_pendingGen = 0;
    double m_pendingSince = 0.0;
};

}  // namespace qsys
