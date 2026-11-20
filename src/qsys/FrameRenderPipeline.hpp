// -*-Mode: C++;-*-
//
// FrameRenderPipeline: off-screen multi-pass orchestration for the GTAO AO and
// post-process AA paths (scene -> [GTAO -> denoise] -> composite ->
// [FXAA/SMAA] -> [temporal jitter]). AO and AA are independent: either one
// routes the frame through this pipeline.
//
// Extracted from GUIView::drawScene so the same pass chain serves both the live
// view and the off-screen exporter, and so the future tritium (WebGL2) port
// touches one class. The pipeline owns the render targets and the fullscreen
// post-process primitive; the View keeps camera/projection, jitter control flow,
// and the UI overlay. All GPU access goes through gfx:: abstract interfaces, so
// the class is platform-agnostic (it never issues a raw GL call).
//

#pragma once

#include "qsys.hpp"

#include <gfx/PostProcGpuPrim.hpp>  // gfx::AoConstants (by-value Params member)

#include <functional>
#include <vector>

namespace gfx {
class DisplayContext;
class RenderTarget;
class PostProcGpuPrim;
}  // namespace gfx

namespace qsys {

/// View-decided inputs for one FrameRenderPipeline::render() call. The Scene-owned
/// render settings (AO tuning, AA method, background color) are read by the
/// pipeline directly from the ScenePtr; only the values the View controls (camera
/// constants, jitter control flow, output routing) are passed here.
struct FrameRenderParams
{
    /// Camera-derived AO constants (View owns the derivation; see
    /// GUIView::computeAoConstants). The AO tuning fields and the AO-buffer texel
    /// size / half-res variant are filled inside render().
    gfx::AoConstants camAoc;

    /// GTAO noise rotation [0,1) for temporal supersampling (0 = single frame).
    float aoNoiseOffset = 0.0f;

    /// Run the GTAO + denoise passes and multiply the AO term in the composite.
    /// false = the pipeline serves AA only: the scene color passes through the
    /// composite unchanged (u_hasAO == 0 plain copy).
    bool enableAO = true;

    /// Clear the scene target's background alpha to 0 (transparent export).
    bool bgTransparent = false;

    /// Apply the Scene's spatial post-AA (FXAA/SMAA) after the composite. The
    /// live path passes true; the off-screen exporter passes false (composite
    /// only, blend off so transparent pixels keep their alpha).
    bool enablePostAA = true;

    /// Temporal-jitter supersampling: accumulate this sample into the float
    /// buffer and display the running average. The View owns the sample index /
    /// count and the projection offset; the pipeline only executes the blend.
    bool jitterActive = false;
    int jitterIndex = 0;
    int jitterCount = 1;

    /// Final output target when not jittering. nullptr = default framebuffer.
    /// When jitterActive, the per-sample color goes to the internal sample target
    /// and the average is displayed to the default framebuffer regardless.
    gfx::RenderTarget *outRT = nullptr;

    /// Restore the scene depth into the default framebuffer so the UI overlay
    /// z-tests against the scene (live path). The exporter passes false.
    bool blitDepthToDefault = false;

    /// Live path: defer the ambient probe bake while the geometry keeps
    /// changing (draw without the probes, bake once it has settled). The
    /// exporter passes false and bakes at once.
    bool deferProbeBake = false;
};

/// Owns the off-screen render targets + the fullscreen post-process primitive and
/// runs the GTAO AO multi-pass chain. Lifecycle mirrors the molstar pass shape:
/// setSize (idempotent (re)alloc) / render / dispose.
class QSYS_API FrameRenderPipeline
{
public:
    FrameRenderPipeline() = default;
    ~FrameRenderPipeline();

    /// (Re)create the render targets at the given backing-pixel size. Idempotent:
    /// existing targets are resized, not reallocated. When halfRes is true the
    /// GTAO term targets (AO / denoise) are allocated at half resolution; the
    /// scene and composite targets stay full resolution. When aoEnabled is false
    /// the AO term targets and the scene target's MRT normal attachment are not
    /// allocated (released if present) to save VRAM and scene-pass bandwidth;
    /// toggling AO recreates the scene target with the matching attachments.
    void setSize(gfx::DisplayContext *pdc, int w, int h, bool halfRes,
                 bool aoEnabled);

    /// Release all render targets and the post-process primitive. Does NOT touch
    /// the display context (the targets self-guard the GL context via their parent
    /// view id), so it is safe to call from a destructor after the concrete view
    /// subclass is gone.
    void dispose();

    /// True once the core targets and post-process primitive exist (setSize ran).
    bool isReady() const;

    /// Run the pass chain: scene(via sceneRenderFn) -> [GTAO -> denoise (when
    /// params.enableAO)] -> composite -> [post-AA] -> [jitter
    /// accumulate/display] -> [depth blit]. pScene supplies AO/AA/background
    /// settings. sceneRenderFn sets the model matrix and calls
    /// pScene->display(pdc); the pipeline binds/clears the scene target around
    /// it. Returns true when the chain ran (always true once isReady()); the
    /// caller handles the plain-scene fallback when not ready.
    bool render(gfx::DisplayContext *pdc, const ScenePtr &pScene,
                const FrameRenderParams &params,
                const std::function<void()> &sceneRenderFn);

    /// Re-present the last live frame (render() with enablePostAA) into the
    /// currently bound default framebuffer by replaying only its final stage
    /// (composite / FXAA / SMAA blend / jitter average display) from the
    /// intermediate targets, which are untouched until the next render(), then
    /// restore the scene depth like render() does. Serves a frame whose 3D
    /// content is unchanged (only the hover highlight overlay changed) without
    /// re-rendering the scene or disturbing the jitter accumulation. Returns
    /// false when no live frame is cached (never rendered, or setSize /
    /// dispose since).
    bool presentLast(gfx::DisplayContext *pdc);

    /// True while presentLast() can replay the last live frame.
    bool hasCachedStage() const;

    /// True when the last render() deferred an ambient probe bake: the view
    /// must keep redrawing until the geometry settles and the bake runs.
    bool isProbeBakePending() const { return m_bProbePending; }

    /// True when the last render() (re)baked the ambient probes: the image
    /// changed, so a temporal-jitter accumulation in progress must restart.
    bool isProbeBaked() const { return m_bProbeBaked; }

    /// Backing-pixel size of the scene target (0 before setSize).
    int getWidth() const;
    int getHeight() const;

    /// The fullscreen post-process primitive (nullptr before setSize). Lets the
    /// view draw its own screen-space overlays with the same primitive.
    gfx::PostProcGpuPrim *getPostProc() const
    {
        return m_pAOPostProc;
    }

private:
    /// Final blend output target: the internal jitter sample target while
    /// jittering, otherwise the caller-supplied target (nullptr = default fb).
    gfx::RenderTarget *selectOutRT(const FrameRenderParams &params) const;

    /// The AO pass target when its second attachment holds the bitmask AO's
    /// gathered indirect light for the composite, otherwise nullptr.
    gfx::RenderTarget *bounceRT(const gfx::AoConstants &aoc, bool aoActive) const
    {
        return (aoActive && aoc.aoMethod == 1 /* Scene::AOM_FASTGI */ && aoc.bounceStrength > 0.0f &&
                aoc.debugView == 0)
                   ? m_pAoRT
                   : nullptr;
    }

    /// The final stage of the last live frame: what to draw, with the exact
    /// constants it was drawn with, so presentLast() reproduces the frame.
    struct StageRecord
    {
        /// COPY: m_pCompRT as is (a frame with veils and no post-AA: the
        /// veils and the labels on top are composited there).
        enum Kind { NONE, COMPOSITE, FXAA, SMAA, JITTER, COPY };
        Kind kind = NONE;
        gfx::AoConstants aoc;
        bool aoActive = false;
        /// JITTER: normalization weight of the displayed partial average.
        float dispWeight = 1.0f;
        bool blitDepth = false;
    };
    StageRecord m_lastStage;

    /// Draw the given final stage into the currently bound framebuffer. The
    /// caller sets depth test / blend off around it.
    void presentStage(gfx::DisplayContext *pdc, const StageRecord &st);

    /// Composite the translucent veils (Scene::getVeilAlphas) over the
    /// background already in m_pCompRT, then draw the labels on top there:
    /// each veil is drawn opaque into m_pVeilRT from the background's depth,
    /// accumulated into m_pVeilAccRT / m_pVeilLogRT, and blended over the
    /// background per pixel (veil_composite_frag.glsl). Returns false when
    /// the veil targets cannot be allocated (the veils are then left out).
    bool compositeVeils(gfx::DisplayContext *pdc, const ScenePtr &pScene,
                        const std::vector<double> &veils,
                        const std::function<void()> &sceneRenderFn);

    /// Bake (or keep) the ambient probes of the bitmask AO and fill `probe`
    /// for the AO pass. Sets m_bProbePending / m_bProbeBaked for this frame
    /// (see isProbeBakePending / isProbeBaked). Called before the AO target is
    /// bound: a (re)bake binds its own targets, and unbinding them returns to
    /// the default framebuffer.
    /// @return &probe when the probes are used this frame, otherwise nullptr.
    const gfx::AoProbeParams *prepareProbes(gfx::DisplayContext *pdc, const ScenePtr &pScene,
                                            int aoMethod, const qlib::Matrix4D &modelView,
                                            bool deferBake, gfx::AoProbeParams &probe);

    /// Baked world-space ambient probes for the bitmask AO (owned, lazily
    /// created).
    class AmbientProbeVolume *m_pProbe = nullptr;
    bool m_bProbePending = false;
    /// The last render() (re)baked the probes (see isProbeBaked).
    bool m_bProbeBaked = false;

    /// Scene colour is RGBA16F (unclamped lighting, clamped in the composite)
    /// while the bitmask AO applies the occlusion to the ambient light only.
    bool m_bSceneHdr = false;
    /// (Re)create the scene target with the current attachment set.
    void createSceneRT(gfx::DisplayContext *pdc, int w, int h, bool aoEnabled);

    /// Off-screen scene target (color + depth + MRT normal).
    gfx::RenderTarget *m_pAOSceneRT = nullptr;
    /// GTAO term + packed edges, and its edge-aware denoised result.
    gfx::RenderTarget *m_pAoRT = nullptr;
    gfx::RenderTarget *m_pAoDenRT = nullptr;
    /// LINEAR composite target feeding the post-process AA stage.
    gfx::RenderTarget *m_pCompRT = nullptr;
    /// SMAA intermediates (edges, blending weights).
    gfx::RenderTarget *m_pSmaaEdgeRT = nullptr;
    gfx::RenderTarget *m_pSmaaWeightRT = nullptr;
    /// Temporal-jitter per-sample color (RGBA8) and float accumulation (RGBA16F).
    gfx::RenderTarget *m_pJitterSampleRT = nullptr;
    gfx::RenderTarget *m_pJitterAccumRT = nullptr;
    /// Veil composite: one veil drawn opaque (colour + depth), and the float
    /// accumulations (sum of a * colour and a; sum of -log(1 - a)).
    /// Allocated on the first frame with veils.
    gfx::RenderTarget *m_pVeilRT = nullptr;
    gfx::RenderTarget *m_pVeilAccRT = nullptr;
    gfx::RenderTarget *m_pVeilLogRT = nullptr;

    /// Fullscreen post-processing primitive (GTAO + denoise + composite + AA +
    /// jitter compose). Owned.
    gfx::PostProcGpuPrim *m_pAOPostProc = nullptr;

    /// True when the float accumulation target was created successfully. Desktop
    /// GL always supports it; a backend lacking float color attachments (e.g. a
    /// WebGL2 context without EXT_color_buffer_float) leaves it false so the
    /// jitter path degrades gracefully to non-jittered rendering.
    bool m_jitterSupported = false;

    enum TimingPass {
        TP_SCENE,
        TP_GTAO,
        TP_DENOISE,
        TP_COMPOSITE,
        TP_POSTAA,
        TP_COUNT
    };

    /// Per-pass timing (Scene.renderTiming): the CPU time spent submitting each
    /// pass (WebGL cannot wait for the GPU: gl.finish() returns at once in
    /// Chromium), logged as averages every TIMING_REPORT_FRAMES frames together
    /// with the wall time between frames, which is the real frame time.
    class PassTimer
    {
    public:
        PassTimer(gfx::DisplayContext *pdc, bool on);
        /// Add the time since the previous mark to `pass`.
        void mark(int pass);
        bool isOn() const { return m_bOn; }
        double elapsed(int pass) const { return m_ms[pass]; }

    private:
        gfx::DisplayContext *m_pdc;
        bool m_bOn;
        double m_tPrev;
        double m_ms[TP_COUNT] = {0, 0, 0, 0, 0};
    };
    enum { TIMING_REPORT_FRAMES = 30 };
    double m_timingSum[TP_COUNT] = {0, 0, 0, 0, 0};
    int m_timingFrames = 0;
    /// Wall time between consecutive timed frames (the real frame time: the
    /// render loop waits for the GPU when it falls behind). Gaps over 200 ms
    /// (idle) are not counted.
    double m_timingLastMs = 0.0;
    std::vector<double> m_timingIntervals;
    /// Add one frame's timings and log the averages when enough have gathered.
    void reportTiming(const PassTimer &timer);
};

}  // namespace qsys
