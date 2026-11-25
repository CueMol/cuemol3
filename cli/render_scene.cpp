//
//  Headless scene rendering (qsc -> PNG) with the umbreon ray tracer
//

#include <common.h>

#include "render_scene.hpp"

#include <cstdio>
#include <string>

#include <boost/filesystem/operations.hpp>
#include <boost/filesystem/path.hpp>

#include <libcuemol2_api/binding.hpp>
#include <qlib/LScrTime.hpp>
#include <qlib/LVarArgs.hpp>
#include <qlib/LVariant.hpp>
#include <qsys/Camera.hpp>
#include <qsys/InOutHandler.hpp>
#include <qsys/Scene.hpp>
#include <qsys/SceneAppData.hpp>
#include <qsys/SceneExporter.hpp>
#include <qsys/StreamManager.hpp>
#include <qsys/anim/AnimMgr.hpp>
#include <qsys/command/LoadSceneCommand.hpp>

namespace cuetty {

using qlib::LString;
namespace fs = boost::filesystem;

namespace {

using ExporterPtr = qlib::LScrSp<qsys::SceneExporter>;

/// Load a scene, or return null (logging why) when it cannot be loaded in
/// full: the reader goes on past data it cannot load, which would render an
/// image without that data and report success.
qsys::ScenePtr loadScene(const std::string &qscPath)
{
    // m_fileFmt is deliberately left empty so the command guesses the format
    // from the file name: the registered scene-reader nickname is "qsc_xml",
    // not "qsc", and a wrong nickname makes StreamManager::createHandler
    // return null.
    qsys::LoadSceneCommand cmd;
    cmd.m_filePath = qscPath.c_str();
    cmd.m_bSetCamera = false;
    try {
        cmd.run();
    } catch (const qlib::LException &e) {
        LOG_DPRINTLN("render> cannot load scene file %s: %s", qscPath.c_str(),
                     e.getMsg().c_str());
        return qsys::ScenePtr();
    }

    if (cmd.m_pResScene.isnull()) {
        LOG_DPRINTLN("render> cannot load scene file: %s", qscPath.c_str());
        return qsys::ScenePtr();
    }
    if (!cmd.m_loadErrors.empty()) {
        for (const LString &msg : cmd.m_loadErrors)
            LOG_DPRINTLN("render> load error: %s", msg.c_str());
        LOG_DPRINTLN(
            "render> %s refers to data that could not be loaded (%d error(s)); "
            "save the scene with its data embedded, or make the files it "
            "refers to reachable from here",
            qscPath.c_str(), int(cmd.m_loadErrors.size()));
        return qsys::ScenePtr();
    }
    return cmd.m_pResScene;
}

/// Create the umbreon exporter and configure it from the scene's render
/// settings, as the GUI does; `bPerspec` is the projection of the camera the
/// image is rendered from, used when the scene has no settings of its own.
/// Returns null (logging why) on failure.
ExporterPtr makeExporter(const qsys::ScenePtr &pScene, const RenderOpts &opts,
                         bool bPerspec)
{
    // umbreon renders in-process and writes the PNG itself. Its writer is only
    // registered when libcuemol2 is built with ENABLE_UMBREON=ON, so a null
    // handler here means the backend is missing rather than a bad name.
    ExporterPtr pExporter(qsys::StreamManager::getInstance()->createHandler(
                              "umbreon", qsys::InOutHandler::IOH_CAT_RENDTOFILE),
                          qlib::no_throw_tag());
    if (pExporter.isnull()) {
        LOG_DPRINTLN(
            "render> umbreon exporter is not available; "
            "libcuemol2 must be built with ENABLE_UMBREON=ON");
        return ExporterPtr();
    }

    // Configure the exporter from the scene's render settings (Scene app data
    // "render", what the tritium Rendering window stores per scene), or from
    // the RenderSettings class defaults -- the window's starting point for a
    // scene without settings of its own -- so the image is what the GUI would
    // render. The mapping is UmbreonSceneExporter::applyRenderSettings, shared
    // with the GUI and the Python module; it is reached through the scriptable
    // interface because the render module's headers are not installed.
    if (!pExporter->hasMethod("applyRenderSettings")) {
        LOG_DPRINTLN("render> this build has no applyRenderSettings API");
        return ExporterPtr();
    }
    qsys::SceneAppDataPtr pStored = pScene->getAppData("render");
    const bool bStored = !pStored.isnull();
    LString backend;
    {
        qlib::LVarArgs args(2);
        if (bStored) {
            // the scene keeps the object alive across the call
            args.at(0).shareObjectPtr(&pStored);
        } else {
            // A transient object at the class defaults. A render is not an
            // edit, so no settings holder is created in the scene.
            qlib::LScriptable *pFresh = nullptr;
            LString errmsg;
            if (!cuemol2::createObj("RenderSettings", "", &pFresh, errmsg)) {
                LOG_DPRINTLN("render> cannot create RenderSettings: %s",
                             errmsg.c_str());
                return ExporterPtr();
            }
            args.at(0).setObjectPtr(pFresh);  // owned by the variant
        }
        args.at(1).setStringValue("");  // backend block: the scene's choice
        pExporter->invokeMethod("applyRenderSettings", args);
        backend = args.retval().getStringValue();
    }

    if (!bStored) {
        // No settings of its own: as the Rendering window does for such a
        // scene, follow the projection the scene's camera was saved with.
        // View::setCameraAnim copies the whole Camera (perspec included) into
        // the view's current camera, so the saved camera records what the GL
        // view showed.
        pExporter->setProperty("perspective", qlib::LVariant(bPerspec));
    }

    // Command-line overrides
    if (opts.width > 0) pExporter->setWidth(opts.width);
    if (opts.height > 0) pExporter->setHeight(opts.height);

    LOG_DPRINTLN("render> %s render settings, backend '%s', %dx%d",
                 bStored ? "scene" : "default", backend.c_str(),
                 pExporter->getWidth(), pExporter->getHeight());
    return pExporter;
}

/// Write the exporter's image to `path` through a temporary file in the same
/// directory, renamed into place only once the image is written and closed.
/// A frame file that exists is therefore complete, which --skip-existing
/// relies on after a job is killed or runs out of disk space.
void writeAtomically(const ExporterPtr &pExporter, const std::string &path)
{
    const std::string tmp = path + ".tmp";
    pExporter->setPath(tmp.c_str());
    try {
        pExporter->write();
    } catch (...) {
        std::remove(tmp.c_str());
        throw;
    }
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        std::remove(tmp.c_str());
        MB_THROW(qlib::IOException, LString("cannot rename to ") + path.c_str());
    }
}

/// Contiguous range [first, last] of shard `i` of `n` over `count` frames;
/// the first (count % n) shards take one frame more. last < first when the
/// shard is empty (more shards than frames).
void shardRange(int count, int i, int n, int &first, int &last)
{
    const int base = count / n;
    const int rem = count % n;
    first = i * base + (i < rem ? i : rem);
    last = first + base + (i < rem ? 1 : 0) - 1;
}

std::string frameFileName(const std::string &outBase, int frame)
{
    char buf[32];
    std::snprintf(buf, sizeof buf, "_frm_%04d.png", frame);
    return outBase + buf;
}

}  // namespace

int renderSceneToPng(const std::string &qscPath, const std::string &outPng,
                     const RenderOpts &opts)
{
    qsys::ScenePtr pScene = loadScene(qscPath);
    if (pScene.isnull()) return 1;

    const LString camName(opts.camera.c_str());
    if (!pScene->hasCamera(camName)) {
        LOG_DPRINTLN("render> scene has no camera named '%s'", opts.camera.c_str());
        return 1;
    }
    qsys::CameraPtr pCam = pScene->getCamera(camName);

    ExporterPtr pExporter = makeExporter(pScene, opts, pCam->isPerspec());
    if (pExporter.isnull()) return 1;
    pExporter->setCameraName(camName);
    LOG_DPRINTLN("render> camera '%s'", opts.camera.c_str());

    pExporter->attach(pScene);
    try {
        writeAtomically(pExporter, outPng);
    } catch (...) {
        pExporter->detach();
        throw;
    }
    pExporter->detach();

    LOG_DPRINTLN("render> wrote %s (%dx%d)", outPng.c_str(), pExporter->getWidth(),
                 pExporter->getHeight());
    return 0;
}

int renderMovieFrames(const std::string &qscPath, const RenderOpts &opts,
                      const MovieOpts &movie)
{
    qsys::ScenePtr pScene = loadScene(qscPath);
    if (pScene.isnull()) return 1;

    qlib::LScrSp<qsys::AnimMgr> pAnimMgr = pScene->getAnimMgr();
    if (pAnimMgr.isnull() || pAnimMgr->getSize() <= 0) {
        LOG_DPRINTLN("render> scene has no animation to render");
        return 1;
    }

    // Start camera, by the GUI's rule: the animation's own choice stands
    // unless it names none or one the scene no longer has; then the camera
    // given here. Without a view, AnimMgr would otherwise start from a
    // default-constructed camera.
    LString startCam = pAnimMgr->getStartCamName();
    if (startCam.isEmpty() || !pScene->hasCamera(startCam)) {
        startCam = opts.camera.c_str();
        if (!pScene->hasCamera(startCam)) {
            LOG_DPRINTLN("render> scene has no camera named '%s' to start from",
                         opts.camera.c_str());
            return 1;
        }
        pAnimMgr->setStartCamName(startCam);
    }

    int nFrames = pAnimMgr->setupRender(qlib::LScrTime(0),
                                        qlib::LScrTime(pAnimMgr->getLength()),
                                        movie.fps);
    if (!movie.lastFrame) --nFrames;
    if (nFrames <= 0) {
        pAnimMgr->stop();
        LOG_DPRINTLN("render> the animation has no frames to render");
        return 1;
    }

    if (movie.listOnly) {
        pAnimMgr->stop();
        std::printf("frames: %d (0-%d)\n", nFrames, nFrames - 1);
        for (int i = 0; i < movie.shardCount; ++i) {
            int a, b;
            shardRange(nFrames, i, movie.shardCount, a, b);
            if (b < a)
                std::printf("shard %d/%d: none\n", i, movie.shardCount);
            else
                std::printf("shard %d/%d: %d-%d\n", i, movie.shardCount, a, b);
        }
        return 0;
    }

    // The frames this run renders
    int first = 0, last = nFrames - 1;
    if (movie.shardCount > 0) {
        shardRange(nFrames, movie.shardIndex, movie.shardCount, first, last);
    } else {
        if (movie.firstFrame >= 0) first = movie.firstFrame;
        if (movie.lastFrameNo >= 0) last = movie.lastFrameNo;
        if (last > nFrames - 1) last = nFrames - 1;
        if (first > last) {
            pAnimMgr->stop();
            LOG_DPRINTLN("render> no frames in the range (the animation has 0-%d)",
                         nFrames - 1);
            return 1;
        }
    }
    if (last < first) {
        // more shards than frames: this one has nothing to do
        pAnimMgr->stop();
        LOG_DPRINTLN("render> shard %d/%d has no frames (the animation has %d)",
                     movie.shardIndex, movie.shardCount, nFrames);
        return 0;
    }

    // Shards of an array job start together and all create the same output
    // directory. create_directories can fail with EEXIST when another process
    // makes the directory between its check and its mkdir (seen with several
    // Slurm tasks on one node), so only fail when there is no directory after.
    const fs::path outDir = fs::path(movie.outBase).parent_path();
    if (!outDir.empty()) {
        boost::system::error_code ec;
        fs::create_directories(outDir, ec);
        if (!fs::is_directory(outDir)) {
            pAnimMgr->stop();
            LOG_DPRINTLN("render> cannot create output directory %s: %s",
                         outDir.string().c_str(), ec.message().c_str());
            return 1;
        }
    }

    qsys::CameraPtr pCam = pScene->getCamera(startCam);
    ExporterPtr pExporter = makeExporter(pScene, opts, pCam->isPerspec());
    if (pExporter.isnull()) {
        pAnimMgr->stop();
        return 1;
    }
    LOG_DPRINTLN("render> frames %d-%d of 0-%d, %.3g fps, start camera '%s'", first,
                 last, nFrames - 1, movie.fps, startCam.c_str());

    // Step through every frame from 0: beginFrame() applies the frame's state
    // (and attaches the exporter with the animation's camera), endFrame()
    // detaches and moves on. Only frames in [first, last] are ray traced.
    int nWritten = 0, nSkipped = 0;
    try {
        for (int frame = 0; frame <= last; ++frame) {
            if (!pAnimMgr->beginFrame(pExporter)) {
                MB_THROW(qlib::RuntimeException, "the animation ended early");
            }
            try {
                if (frame >= first) {
                    const std::string path = frameFileName(movie.outBase, frame);
                    if (movie.skipExisting && fs::exists(path)) {
                        ++nSkipped;
                    } else {
                        writeAtomically(pExporter, path);
                        ++nWritten;
                        LOG_DPRINTLN("render> wrote %s", path.c_str());
                    }
                }
            } catch (...) {
                pAnimMgr->endFrame(pExporter);
                throw;
            }
            pAnimMgr->endFrame(pExporter);
        }
    } catch (...) {
        pAnimMgr->stop();
        throw;
    }
    pAnimMgr->stop();

    LOG_DPRINTLN("render> %d frame(s) written, %d existing frame(s) skipped", nWritten,
                 nSkipped);
    return 0;
}

}  // namespace cuetty
