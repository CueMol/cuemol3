
#include <common.h>
#include <libcuemol2_api/loader.hpp>

#include "render_scene.hpp"

#include <cstdlib>
#include <iostream>
#include <string>
#include <optional>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#include <boost/filesystem/path.hpp>
#include <boost/filesystem/operations.hpp>
#include <boost/program_options.hpp>

#include <qlib/qlib.hpp>
#include <qlib/FileStream.hpp>

#include <qsys/qsys.hpp>
#include <qsys/SceneManager.hpp>
#include <qsys/command/LoadSceneCommand.hpp>
#include <qsys/SysConfig.hpp>

#ifdef ENABLE_PYTHON_EMBED
#include <pybr/PythonBridge.hpp>
#endif

using qlib::LString;
void process_input(const LString &loadscr, bool bInvokeIntrShell);

#ifndef DEFAULT_CONFIG
#define DEFAULT_CONFIG "./sysconfig.xml"
#endif

namespace po = boost::program_options;

struct Config
{
    bool interactive;
    std::string input_file;
    std::string config_file;

    /// Output PNG path; non-empty selects headless render mode.
    std::string render_file;
    /// Movie mode (movie.outBase non-empty) or the frame listing
    cuetty::MovieOpts movie;
    bool bMovie = false;

    cuetty::RenderOpts render;

    /// Thread cap for the ray tracer; 0 = from the environment
    int threads = 0;
};

namespace {

/// True for a path that names a directory rather than <dir>/<base>
bool isDirectoryLike(const std::string &p)
{
    return p.back() == '/' || boost::filesystem::is_directory(p);
}

/// Parse "A-B" (both >= 0, A <= B)
bool parseRange(const std::string &s, int &a, int &b)
{
    const auto dash = s.find('-');
    if (dash == std::string::npos) return false;
    try {
        size_t n1 = 0, n2 = 0;
        a = std::stoi(s.substr(0, dash), &n1);
        b = std::stoi(s.substr(dash + 1), &n2);
        if (n1 != dash || n2 != s.size() - dash - 1) return false;
    } catch (...) {
        return false;
    }
    return a >= 0 && a <= b;
}

/// Parse "I/N" (0 <= I < N)
bool parseShard(const std::string &s, int &i, int &n)
{
    const auto slash = s.find('/');
    if (slash == std::string::npos) return false;
    try {
        size_t n1 = 0, n2 = 0;
        i = std::stoi(s.substr(0, slash), &n1);
        n = std::stoi(s.substr(slash + 1), &n2);
        if (n1 != slash || n2 != s.size() - slash - 1) return false;
    } catch (...) {
        return false;
    }
    return n >= 1 && i >= 0 && i < n;
}

}  // namespace

std::optional<Config> parse_arguments(int argc, const char *argv[])
{
    /// argment parser
    po::options_description desc("Allowed options");
    const cuetty::RenderOpts defs;
    const cuetty::MovieOpts mdefs;
    desc.add_options()("help,h", "Show help message")("interactive,i",
                                                      "Run in interactive mode")(
        "input", po::value<std::string>()->default_value(""), "Input file")(
        "config,c", po::value<std::string>()->default_value(""),
        "Config file (default: share/sysconfig_cuemol3.xml next to bin/)")(
        "render,r", po::value<std::string>()->default_value(""),
        "Render the input scene into this PNG file and exit (headless)")(
        "width", po::value<int>(),
        "Render width in pixels (default: the scene's render settings)")(
        "height", po::value<int>(),
        "Render height in pixels (default: the scene's render settings)")(
        "camera", po::value<std::string>()->default_value(defs.camera),
        "Camera name to render from (movie: the start camera when the "
        "animation names none)")(
        "threads", po::value<int>(),
        "Number of render threads (default: SLURM_CPUS_PER_TASK, then "
        "OMP_NUM_THREADS, else all cores)")(
        "movie", po::value<std::string>(),
        "Render the scene's animation into <dir>/<base>_frm_NNNN.png and exit")(
        "fps", po::value<double>()->default_value(mdefs.fps), "Movie frame rate")(
        "no-last-frame", "Do not render the last frame (for a looping movie)")(
        "frames", po::value<std::string>(),
        "Movie frames to render, A-B (inclusive, 0-based)")(
        "shard", po::value<std::string>(),
        "Render part I of N contiguous parts of the movie frames, I/N (0-based)")(
        "skip-existing", "Leave movie frames whose files already exist")(
        "list-frames",
        "Print the movie frame count (and the --shard N ranges) and exit");

    po::variables_map vm;

    try {
        po::store(po::parse_command_line(argc, argv, desc), vm);

        // Handle help option
        if (vm.count("help")) {
            std::cout << desc << std::endl;
            return std::nullopt;
        }

        po::notify(vm);

    } catch (const po::error &e) {
        std::cerr << "Error: " << e.what() << std::endl;
        std::cerr << desc << std::endl;
        return std::nullopt;
    }

    Config config;
    config.interactive = vm.count("interactive") > 0;
    config.input_file = vm["input"].as<std::string>();
    config.config_file = vm["config"].as<std::string>();
    config.render_file = vm["render"].as<std::string>();
    config.render.width = vm.count("width") ? vm["width"].as<int>() : 0;
    config.render.height = vm.count("height") ? vm["height"].as<int>() : 0;
    config.render.camera = vm["camera"].as<std::string>();

    auto fail = [](const char *msg) -> std::optional<Config> {
        std::cerr << "Error: " << msg << std::endl;
        return std::nullopt;
    };

    if (vm.count("threads")) {
        config.threads = vm["threads"].as<int>();
        if (config.threads <= 0) return fail("--threads must be positive");
    }

    const bool bList = vm.count("list-frames") > 0;
    config.bMovie = vm.count("movie") > 0 || bList;
    if (config.bMovie) {
        cuetty::MovieOpts &m = config.movie;
        if (vm.count("movie")) m.outBase = vm["movie"].as<std::string>();
        m.listOnly = bList;
        m.fps = vm["fps"].as<double>();
        m.lastFrame = vm.count("no-last-frame") == 0;
        m.skipExisting = vm.count("skip-existing") > 0;
        if (!(m.fps > 0)) return fail("--fps must be positive");
        if (vm.count("frames") && vm.count("shard"))
            return fail("--frames and --shard cannot be used together");
        if (vm.count("frames") &&
            !parseRange(vm["frames"].as<std::string>(), m.firstFrame, m.lastFrameNo))
            return fail("--frames takes A-B with 0 <= A <= B");
        if (vm.count("shard") &&
            !parseShard(vm["shard"].as<std::string>(), m.shardIndex, m.shardCount))
            return fail("--shard takes I/N with 0 <= I < N");
        if (!m.listOnly && m.outBase.empty()) return fail("--movie needs <dir>/<base>");
        if (!m.listOnly && isDirectoryLike(m.outBase))
            return fail("--movie takes <dir>/<base>, not a directory");
        if (!config.render_file.empty())
            return fail("--render and --movie cannot be used together");
    }

    if (!config.render_file.empty() || config.bMovie) {
        if (config.input_file.empty()) {
            return fail("--render / --movie require --input <scene file>");
        }
        if ((vm.count("width") && config.render.width <= 0) ||
            (vm.count("height") && config.render.height <= 0)) {
            return fail("--width and --height must be positive");
        }
    }

    return config;
}

// //
// if (vm.count("help")) {
//     std::cout << desc << std::endl;
//     return 0;
// }

// if (vm.count("input")) {
//     std::cout << "Input: " << vm["input"].as<std::string>() << std::endl;
// }

namespace {

/// Directory of the running executable, or empty when it cannot be found
boost::filesystem::path exeDir()
{
    namespace fs = boost::filesystem;
#if defined(__linux__)
    boost::system::error_code ec;
    fs::path exe = fs::read_symlink("/proc/self/exe", ec);
    if (ec) return fs::path();
#elif defined(__APPLE__)
    char buf[4096];
    uint32_t size = sizeof buf;
    if (_NSGetExecutablePath(buf, &size) != 0) return fs::path();
    boost::system::error_code ec;
    fs::path exe = fs::canonical(buf, ec);
    if (ec) return fs::path();
#else
    fs::path exe;
#endif
    return exe.parent_path();
}

/// The config file: --config, else the tritium config of a relocatable
/// install (<prefix>/share/sysconfig_cuemol3.xml next to <prefix>/bin), else
/// the one this build was configured to install. sysconfig_cuemol3.xml also
/// loads the styles the GUI offers (cuemol3_style.xml, e.g.
/// AlphaFoldPlddtColoring), which a GUI-authored scene refers to by name;
/// without them the scene renders in different colours and no error.
LString findConfig(const std::string &given)
{
    if (!given.empty()) return given.c_str();
    const boost::filesystem::path dir = exeDir();
    if (!dir.empty()) {
        const boost::filesystem::path conf =
            dir.parent_path() / "share" / "sysconfig_cuemol3.xml";
        boost::system::error_code ec;
        if (boost::filesystem::is_regular_file(conf, ec)) return conf.string().c_str();
    }
    return DEFAULT_CONFIG;
}

/// Cap the ray tracer's threads: --threads, else the CPUs a Slurm job was
/// given, else OMP_NUM_THREADS, else no cap (every core the node has, which
/// on a shared node is more than the job was allocated). libcuemol2 reads
/// CUEMOL_TBB_THREADS in qlib::init(), so this must run before it.
void applyThreadCap(int threads)
{
    std::string n;
    const char *src = nullptr;
    if (threads > 0) {
        n = std::to_string(threads);
        src = "--threads";
    } else {
        for (const char *var : {"SLURM_CPUS_PER_TASK", "OMP_NUM_THREADS"}) {
            const char *v = std::getenv(var);
            if (v != nullptr && std::atoi(v) >= 1) {
                n = std::to_string(std::atoi(v));
                src = var;
                break;
            }
        }
    }
    if (src == nullptr) return;
#ifdef _WIN32
    ::_putenv_s("CUEMOL_TBB_THREADS", n.c_str());
#else
    ::setenv("CUEMOL_TBB_THREADS", n.c_str(), 1);
#endif
    std::printf("cuetty: %s render threads (%s)\n", n.c_str(), src);
    std::fflush(stdout);
}

/// The Linux x64 tarball's MeshMS is built for x86-64-v3 (AVX2, FMA, BMI1/2,
/// ...), so an older CPU would stop with SIGILL in the middle of building a
/// surface. Fail at start-up with a message instead.
bool checkCpu()
{
#if defined(__linux__) && defined(__x86_64__) && defined(__GNUC__) && \
    !defined(__clang__) && (__GNUC__ >= 12)
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("x86-64-v3")) {
        std::fprintf(stderr,
                     "Error: this cuetty needs an x86-64-v3 CPU "
                     "(AVX2, FMA, BMI1/2; Intel Haswell / AMD Zen or later)\n");
        return false;
    }
#endif
    return true;
}

}  // namespace

///
///   main routine for CueTTY (CLI version)
///
int internal_main(int argc, const char *argv[])
{
    auto config = parse_arguments(argc, argv);
    if (!config) {
        return 1;
    }

    if (!checkCpu()) return 1;

    // Render mode never creates a qsys::View (the umbreon exporter walks the
    // scene through a file DisplayContext), so skip registering the platform's
    // OpenGL view factory and stay headless.
    const bool bRender = !config->render_file.empty() || config->bMovie;
    if (bRender) applyThreadCap(config->threads);

    if (cuemol2::init_qlib()) {
        LOG_DPRINTLN("cuemol2::init_qlib OK.");
    } else {
        printf("Init: ERROR!!\n");
        return -1;
    }

    const LString confpath = findConfig(config->config_file);
    LOG_DPRINTLN("cuetty: config %s", confpath.c_str());

    int result = cuemol2::init(confpath, !bRender);
    if (result < 0) {
        return result;
    }

    int rc = 0;
    if (bRender) {
        try {
            if (config->bMovie)
                rc = cuetty::renderMovieFrames(config->input_file, config->render,
                                               config->movie);
            else
                rc = cuetty::renderSceneToPng(config->input_file, config->render_file,
                                              config->render);
        } catch (const qlib::LException &e) {
            LOG_DPRINTLN("render> error: %s", e.getMsg().c_str());
            rc = 1;
        } catch (const std::exception &e) {
            LOG_DPRINTLN("render> error: %s", e.what());
            rc = 1;
        }
        // Tear the loaded scene down before the modules are finalized below;
        // process_input() does the same for the non-render path. Skipping this
        // crashes in cuemol2::fini().
        qsys::SceneManager::getInstance()->destroyAllScenes();
    } else {
        process_input(config->input_file.c_str(), config->interactive);
    }

    cuemol2::fini();
    cuemol2::fini_qlib();

    if (rc != 0) {
        printf("=== Terminated with error ===\n");
        return rc;
    }

    printf("=== Terminated normaly ===\n");
    return 0;
}

int main(int argc, const char *argv[])
{
    try {
        return internal_main(argc, argv);
    } catch (const qlib::LException &e) {
        LOG_DPRINTLN("Caught exception <%s>", typeid(e).name());
        LOG_DPRINTLN("Reason: %s", e.getMsg().c_str());
    } catch (std::exception &e) {
        LOG_DPRINTLN("Caught exception <%s>", typeid(e).name());
        LOG_DPRINTLN("Reason: %s", e.what());
    } catch (...) {
        LOG_DPRINTLN("Caught unknown exception");
    }
    return 1;
}

namespace fs = boost::filesystem;

void process_input(const LString &loadscr, bool bInvokeIntrShell)
{
    qsys::SceneManager *pSM = qsys::SceneManager::getInstance();
    LOG_DPRINTLN("CueMol version %s build %s", pSM->getVersion().c_str(),
                 pSM->getBuildID().c_str());

    if (!loadscr.isEmpty()) {
        fs::path full_path = fs::system_complete(fs::path(loadscr.c_str()));
        if (full_path.extension() == ".qsc") {
            qsys::LoadSceneCommand cmd;
            cmd.m_filePath = full_path.string().c_str();
            // m_fileFmt is left empty on purpose: the command then guesses the
            // format from the file name. Naming it "qsc" would not resolve --
            // the registered scene-reader nickname is "qsc_xml".
            cmd.run();
        }
    }

    if (bInvokeIntrShell) {
#ifdef ENABLE_PYTHON_EMBED
        MB_DPRINTLN("main> invoking interactive shell ...");
        // invoke interactive shell
        auto *pybr = pybr::PythonBridge::getInstance();
        pybr->runInteractiveShell();
        MB_DPRINTLN("main> interactive shell terminated.");
#else
        LOG_DPRINTLN(
            "main> WARNING: interactive shell is not available "
            "in this build.");
#endif
    }

    MB_DPRINTLN("main> cleanup ...");
    pSM->destroyAllScenes();
    MB_DPRINTLN("main> cleanup done.");
}
