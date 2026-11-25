# cuetty -- CueMol command-line interface

`cuetty` is the CLI front end to libcuemol2. It has two modes:

- **Headless rendering** -- load a scene file and write a PNG image (`--render`)
  or the frames of its animation (`--movie`), with no GUI, no window and no
  OpenGL context.
- **Interactive shell** -- an embedded Python REPL with the CueMol API bound
  (`--interactive`).

---

## Linux tarball (cluster nodes)

Each release has `cuetty-<version>-linux-x64.tar.gz`, a self-contained cuetty
for headless Linux machines such as cluster compute nodes. Unpack it anywhere
and run it by path; no root, `LD_LIBRARY_PATH` or `--config` is needed:

```sh
tar xf cuetty-<version>-linux-x64.tar.gz
cuetty-<version>-linux-x64/bin/cuetty --input scene.qsc --render out.png
```

Requirements:

- x86-64 Linux with **glibc 2.28 or later** (RHEL / Rocky / Alma 8 and 9,
  Ubuntu 20.04+, Debian 10+). It is built in the manylinux_2_28 container.
- An **x86-64-v3 CPU** (AVX2, FMA, BMI1/2: Intel Haswell / AMD Zen or later).
  cuetty checks this at start-up and exits with status 1 on an older CPU.
- No GPU and no display. The OIDN denoiser runs on the CPU.
- Memory: a 1200x1200 image at the default settings (supersampling 3, GI
  with the OIDN denoiser) peaked at about 3 GB; it grows with the pixel
  count times the supersampling. Size `--mem` of a job from that.

**Get the scene's data onto the node.** A `.qsc` refers to the files its
molecules came from unless they were embedded when it was saved. Save the
scene with its data embedded, or copy the files so that the paths it refers
to (relative ones are taken from the `.qsc`'s directory) exist on the node.
An MD trajectory always stays in its own files, even in a scene saved with
embedded data: copy them along with the `.qsc`, keeping their position
relative to it. A scene that refers to data cuetty cannot load fails with
status 1 instead of rendering without it.

---

## Build

`cuetty` is a separate CMake project that links against an installed
libcuemol2, so build libcuemol2 first. From `build_scripts/`:

```sh
task build_cli          # builds libcuemol2, then cuetty
```

The binary is installed to `<repo>/.build_out/cuemol2/bin/cuetty`. It is not
placed on `PATH`; invoke it by path.

`task build_cli` currently only has a macOS variant. Elsewhere, configure and
build `cli/` directly (see `build_scripts/build_cuetty_posix/run.sh` for the
cmake arguments).

**Headless rendering additionally requires libcuemol2 to be built with
`ENABLE_UMBREON=ON`**. CI builds every release artifact that way, but it is
*not* the default for a local build:

```sh
task install_umbreon                        # build+install umbreon into the deplibs prefix
ENABLE_UMBREON=ON task rebuild_libcuemol2   # reconfigure libcuemol2 with umbreon
task build_cli
```

Without it the exporter is never registered and `--render` fails with
`umbreon exporter is not available; libcuemol2 must be built with
ENABLE_UMBREON=ON` (exit status 1). Note that a later plain
`task rebuild_libcuemol2` turns the option back off.

---

## Headless rendering

### Synopsis

```sh
cuetty --input <scene.qsc> --render <out.png> [--width W] [--height H] [--camera NAME]
```

The scene is rendered with **umbreon**, the Embree-based CPU ray tracer.
Nothing in this path touches OpenGL: `UmbreonSceneExporter` needs only the
scene and a camera, and walks the scene through a file `DisplayContext`. No
`qsys::View` is created, so it runs on a machine with no display.

(The GL-based `PngSceneExporter` cannot be used this way -- it requires
`View::createOffScreenView()`, hence an OpenGL context.)

### Options

| Option | Default | Description |
|---|---|---|
| `--input <path>` | -- | Input scene file (`.qsc`). Required with `--render` and `--movie`. |
| `-r`, `--render <path>` | -- | Output PNG path. Supplying it selects render mode: the image is written and cuetty exits. |
| `--width <px>` | scene settings | Image width override. Must be positive. |
| `--height <px>` | scene settings | Image height override. Must be positive. |
| `--camera <name>` | `__current` | Camera to render from. Must exist in the scene. For a movie, the start camera when the animation names none. |
| `--threads <n>` | see below | Number of render threads. |
| `-c`, `--config <path>` | see below | Config file to initialise from. |
| `-h`, `--help` | -- | Print the option list. |

**Threads.** Without `--threads`, cuetty uses `SLURM_CPUS_PER_TASK` (the CPUs a
Slurm job was given), then `OMP_NUM_THREADS`, and otherwise every core of the
machine. On a shared node, give the job's allocation one of these ways.

**Config.** Without `--config`, cuetty uses `share/sysconfig_cuemol3.xml` next
to its `bin/` directory (the layout of the Linux tarball and of an install),
and otherwise the path it was built with. This is the config the GUI uses: it
also loads the styles the GUI offers (such as `AlphaFoldPlddtColoring`), which
a scene refers to by name.

The default camera name is `__current`, which is where the GUI stores the
current view when it writes a `.qsc`, so a GUI-authored scene always has it.
Any other camera saved in the scene can be named instead.

### Exit status

| Status | Meaning |
|---|---|
| `0` | Image written. |
| `1` | Scene could not be loaded in full (a missing file, a corrupt or missing embedded chunk), the named camera does not exist, an argument was invalid, the image could not be written, the CPU is too old, or umbreon is not built in. |

The reason is printed to the log in every failure case, so a script can
branch on the status alone.

### Examples

```sh
CUETTY=.build_out/cuemol2/bin/cuetty

# Defaults (640x480, "__current" camera)
$CUETTY --input scene.qsc --render out.png

# Explicit size
$CUETTY --input scene.qsc --render out.png --width 1920 --height 1080

# A named camera saved in the scene
$CUETTY --input scene.qsc --render side.png --camera side_view

# In a shell script
if ! $CUETTY --input scene.qsc --render out.png --width 1200 --height 900; then
    echo "render failed" >&2
    exit 1
fi
```

### Render settings come from the scene

The exporter is configured from the render settings the scene file stores:
the `<appdata id="render" type="RenderSettings">` element the tritium
Rendering window writes per scene (see
`docs/architecture/scene-app-data.md`). A `.qsc` therefore renders the way
the GUI would render it -- ambient occlusion, shadows, global illumination
and its denoiser, the lighting balance, edge lines, the transparent
background, the image size in its unit at its DPI and, for the umbreon NPR
backend, the hatch look. The mapping onto the exporter is the C++
`UmbreonSceneExporter::applyRenderSettings`, shared with the GUI and the
Python module; cuetty has no settings logic of its own.

Which block of the settings is used follows the scene's `backend` choice:
`umbreon_npr` renders with hatching; anything else (`umbreon`, the unchosen
`""`, and `povray`, which cuetty cannot run) renders with plain umbreon.

A scene that stores no settings (never touched in the Rendering window)
renders with the `RenderSettings` class defaults -- the window's own starting
point: GI lighting with the OIDN denoiser, supersampling 3, 1200x1200 px --
and, as the window does for such a scene, with the projection of the camera
it was saved with (`View::setCameraAnim` copies the whole `Camera`, `perspec`
included, into the view's current camera, so the saved camera records what
the GL view was showing; the class default would render an orthographic
scene in perspective). A scene with stored settings keeps its own
`projection`.

Only the image size and the camera can be overridden from the command line:
`--width` / `--height` replace the stored (or default) size. The log says
which settings were used and what they resolved to:

```
render> scene render settings, backend 'umbreon_npr', 160x120
render> camera '__current'
```

### Movies

```sh
cuetty --input scene.qsc --movie <dir>/<base> [--fps N] [--no-last-frame]
       [--frames A-B | --shard I/N] [--skip-existing]
cuetty --input scene.qsc --list-frames [--fps N] [--no-last-frame] [--shard 0/N]
```

`--movie` renders the frames of the scene's animation (the one the GUI's
Animation panel edits) into `<dir>/<base>_frm_0000.png`, `_frm_0001.png`, ...,
the names the GUI writes. Each frame is set up as a still is: the scene's
render settings, `--width` / `--height`, and the animation's own camera.

| Option | Default | Description |
|---|---|---|
| `--movie <dir>/<base>` | -- | Output directory (created if missing) and base name. |
| `--fps <n>` | 30 | Frame rate. The frame count is the animation length times this, plus one. |
| `--no-last-frame` | off | Leave out the last frame, for a movie that loops (it equals the first). |
| `--frames A-B` | all | Render frames A to B (inclusive, 0-based). |
| `--shard I/N` | -- | Split the frames into N contiguous parts and render part I (0-based). Not with `--frames`. |
| `--skip-existing` | off | Leave frames whose file already exists, to re-run a job that stopped. |
| `--list-frames` | -- | Print the frame count (and, with `--shard 0/N`, the range of each part) and exit. |

The start camera is the one the animation names; when it names none (or one
the scene no longer has), it is `--camera`, as in the GUI.

A run that renders later frames only still steps the animation from frame 0
without ray tracing the frames before its range, so its frames are the same
as those of one run over the whole sequence. A frame is written to a
temporary file and renamed into place once it is complete, so a frame file
that exists is a whole image, and `--skip-existing` never keeps a truncated
one. Frames already in the directory are never deleted (other shards write
there too).

#### Frames on several nodes (Slurm)

```sh
#!/bin/bash
#SBATCH --array=0-3
#SBATCH --cpus-per-task=16
CUETTY=$HOME/cuetty-<version>-linux-x64/bin/cuetty
$CUETTY --input scene.qsc --movie frames/movie --fps 30 \
    --shard $SLURM_ARRAY_TASK_ID/$SLURM_ARRAY_TASK_COUNT
```

Number the array from 0 with no gaps (`--array=0-3`): `--array=1-4` would make
the parts 1/4 to 4/4 and leave out part 0. Each task uses the CPUs it was
given (`SLURM_CPUS_PER_TASK`). Re-submitting with `--skip-existing` renders
only the frames that are missing.

#### Making the movie

cuetty writes frames only. To encode them with ffmpeg the way the GUI does
for MP4 (H.264) at the standard quality:

```sh
ffmpeg -r 30 -i frames/movie_frm_%04d.png -an -crf 23 -c:v libx264 -f mp4 \
    -vf "fps=30,format=yuv420p" -y movie.mp4
```

Use the same rate as `--fps`.

### Text labels are not rendered

Labels (atom names, distance measurements, and other `drawString` output) do
**not** appear in the image. The file `DisplayContext` inherits the no-op
`gfx::DisplayContext::drawString`, so labels are silently skipped -- this is
not an error and does not stop the render. Everything else in a
label-bearing scene, including the measurement lines themselves, renders
normally.

---

## Interactive shell

```sh
cuetty --interactive [--input scene.qsc]
```

Starts the embedded Python interpreter with the CueMol API available. When
`--input` is given, the scene is loaded first, so the shell starts with it
already in the scene manager.

Requires libcuemol2 built with `ENABLE_PYTHON_EMBED=ON`; otherwise cuetty
prints `interactive shell is not available in this build` and exits normally.

---

## Rendering from Python instead

The same render is available from the `cuemol` Python module, driving the
identical C++ path (`load_scene` command, then the umbreon exporter
configured by `applyRenderSettings`) and producing byte-identical images:

```sh
python -m cuemol.umbreon_render scene.qsc out.png [-W 1920 -H 1080] [-c CAMERA]
```

```python
from cuemol import umbreon_render

# render_file returns the loaded scene, so further images (e.g. other
# cameras) can be rendered without reloading it. The size comes from the
# scene's settings unless given.
scene = umbreon_render.render_file("scene.qsc", "front.png")
umbreon_render.render(scene, "side.png", 1920, 1080, camera="side_view")

# To tweak a setting for one render, configure an exporter yourself
exporter = cuemol.strMgr().createHandler("umbreon", 2)
umbreon_render.apply_scene_settings(scene, exporter)
exporter.supersample = 1
```

Prefer the Python entry point for batch work -- several cameras, a sweep over
scenes, or anything that would otherwise be a shell loop. Use `cuetty` when a
self-contained binary with no Python environment is what you want.

Building the module: `task build_pytest`.

---

## Troubleshooting

**`umbreon exporter is not available`** -- libcuemol2 was built with
`ENABLE_UMBREON=OFF` (the default). See [Build](#build).

**`scene has no camera named '__current'`** -- the scene was not written by
the GUI, or was written without saving the view. Pass an existing camera with
`--camera`; `Scene::getCameraInfoJSON()` lists what a scene has.

**`cannot load scene file`** -- the path is wrong, or the file is not a
format any registered scene reader recognises. The format is guessed from the
file name, so the extension must be `.qsc`. The message also names a data file
the scene refers to that does not exist here.

**`refers to data that could not be loaded`** -- the `load error:` lines above
it say what: an embedded chunk that is missing (the file was cut short, e.g.
by an incomplete copy) or cannot be decoded. See
[Linux tarball](#linux-tarball-cluster-nodes) for getting a scene's data onto
another machine.

**`this cuetty needs an x86-64-v3 CPU`** -- the Linux tarball does not run on
CPUs older than Intel Haswell / AMD Zen.

**The Python module fails to import with `Library not loaded:
libpython3.12.dylib`** -- libcuemol2 is built against a bundled Python that
differs from the interpreter running the module. Point the loader at the
bundled runtime, and use the interpreter's real path (a pyenv shim is a shell
script, and macOS SIP strips `DYLD_*` across it):

```sh
DYLD_LIBRARY_PATH=$HOME/tmp/proj64_deplibs/python/lib \
    .venv/bin/python -m cuemol.umbreon_render scene.qsc out.png
```

---

## See also

- `cli/render_scene.{hpp,cpp}` -- the render implementation, kept in its own
  translation unit so it can be reused from another entry point.
- `src/modules/rendering/UmbreonSceneExporter.qif` -- the full exporter
  property set and `applyRenderSettings`, the settings-to-exporter mapping;
  `RenderSettings.qif` (+ `Umbreon*RenderSettings.qif`) is the schema of the
  stored settings.
- `docs/architecture/scene-app-data.md` -- how the settings are stored in the
  scene and applied at render time by the GUI, cuetty and Python alike.
- `docs/architecture/umbreon-process-isolation.md` -- why umbreon renders
  in-process, and the Electron-specific memory limits that do **not** apply to
  a plain CLI process.
