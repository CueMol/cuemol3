// -*-Mode: C++;-*-
//
//  Headless scene rendering (qsc -> PNG) with the umbreon ray tracer
//

#ifndef CUETTY_RENDER_SCENE_HPP_INCLUDED
#define CUETTY_RENDER_SCENE_HPP_INCLUDED

#include <string>

namespace cuetty {

/// Options for a headless scene render. Everything not listed here comes from
/// the render settings stored in the scene file (Scene app data "render",
/// what the tritium Rendering window keeps per scene), or from the class
/// defaults of RenderSettings when the scene holds none; see
/// renderSceneToPng.
struct RenderOpts
{
    /// image width in pixels; 0 = the scene's render settings
    int width = 0;

    /// image height in pixels; 0 = the scene's render settings
    int height = 0;

    /// camera name to render from. The GUI saves the current view under this
    /// name when writing a .qsc, so a GUI-authored scene always has it. For a
    /// movie this is the start camera when the animation names none (or one
    /// the scene does not have), as the GUI does.
    std::string camera = "__current";
};

/// Options for rendering the frames of a scene's animation
struct MovieOpts
{
    /// Output directory and base name: frame i is written to
    /// "<outBase>_frm_<iiii>.png", the names the GUI uses
    std::string outBase;

    double fps = 30.0;

    /// Render the last frame too. Dropping it makes a looping movie, whose
    /// first and last frames would otherwise be the same (the GUI's "Loop").
    bool lastFrame = true;

    /// Frame range to render (inclusive, 0-based); -1 = up to the start/end
    int firstFrame = -1;
    int lastFrameNo = -1;

    /// Render shard `shardIndex` of `shardCount` contiguous parts of the
    /// frames; shardCount 0 = no sharding
    int shardIndex = 0;
    int shardCount = 0;

    /// Leave a frame whose file already exists alone (re-running a job)
    bool skipExisting = false;

    /// Print the frame count (and the shards' ranges) and render nothing
    bool listOnly = false;
};

/// Load a CueMol scene file and render it into a PNG image with umbreon.
///
/// The exporter is configured from the scene's render settings through
/// UmbreonSceneExporter::applyRenderSettings (the one mapping shared with the
/// GUI and the Python module): the stored settings when the scene has them,
/// else the RenderSettings class defaults, with the projection then taken
/// from the scene's camera as the GUI does for such a scene. The backend
/// block is the scene's choice (umbreon_npr renders with hatching; anything
/// else, including POV-Ray, renders with plain umbreon). `opts` overrides
/// the image size and names the camera.
///
/// Needs neither a qsys::View nor an OpenGL context: the exporter walks the
/// scene through a file DisplayContext. Text labels are not drawn (the file
/// DisplayContext inherits the no-op gfx::DisplayContext::drawString).
///
/// A scene that refers to data it cannot load (a missing file, a corrupt or
/// missing embedded chunk) fails rather than rendering without that data.
///
/// Returns 0 on success and 1 on failure, logging the reason.
int renderSceneToPng(const std::string &qscPath, const std::string &outPng,
                     const RenderOpts &opts);

/// Render frames of the scene's animation, set up as renderSceneToPng sets
/// up a still. The animation is stepped from frame 0 even when the frames to
/// render start later, since an animation object may take its start state
/// from the frame it starts at (RendXformAnim takes the camera's direction);
/// only the frames to render are ray traced. Each frame is written to a
/// temporary file and renamed into place once it is complete, so a frame file
/// that exists is a whole image. Existing frames of other shards are left
/// alone. Returns 0 on success and 1 on failure.
int renderMovieFrames(const std::string &qscPath, const RenderOpts &opts,
                      const MovieOpts &movie);

}  // namespace cuetty

#endif
