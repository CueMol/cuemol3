#!/bin/bash
#
# download external packages on Windows (Git Bash / MSYS)
# usage: run_win.sh base_dir [host_arch]
#   host_arch ... X64 (default)
#
# Windows publishes apbs / povray as a single prebuilt bundle asset, so this
# fetches one archive instead of the separate downloads the posix run.sh does.
# The bundle's ffmpeg is an old build, so it is replaced by the ffmpeg archive
# from the third-party mirror. The resulting layout is the same
# (BASEDIR/{apbs,povray,ffmpeg}), which is what collect-cuemol2-runtime.sh
# stages into the installer via BUNDLE_APPS.

usage()
{
    echo "usage: run_win.sh base_dir [host_arch]"
    echo "  host_arch ... X64"
    exit 1
}

if [ -z "${1:-}" ]; then
   usage
fi

set -eux

# Dependency versions are defined in build_scripts/deplibs.env
. "$(cd "$(dirname "$0")/.."; pwd)/deplibs.env"

# The caller may hand over a native path (Taskfile WORKDIR is "c:\..."; the CI
# action passes the workspace-relative basedir), so normalize it first.
BASEDIR=$(cygpath -u "$1")
RUNNER_ARCH=${2:-X64}

TMPDIR=$BASEDIR/tmp
mkdir -p "$TMPDIR"
cd "$TMPDIR"

PKG_TGZ=extpkgs_Windows_${RUNNER_ARCH}.tar.bz2
curl -sS -L -O \
     https://github.com/CueMol/povray_build/releases/download/$EXTPKGS_VER_WINDOWS/$PKG_TGZ

# The bundle carries apbs/, povray/ and ffmpeg/ at its top level.
mkdir -p "$BASEDIR"
cd "$BASEDIR"
tar xjf "$TMPDIR/$PKG_TGZ"

# Replace the bundle's ffmpeg with the mirrored build. Only ffmpeg.exe (plus the
# license) is shipped; ffplay / ffprobe are not used.
cd "$TMPDIR"
curl -fsSL --retry 3 -O "$THIRDPARTY_MIRROR_URL/${FFMPEG_DIST_WINDOWS}.zip"
rm -rf "$TMPDIR/$FFMPEG_DIST_WINDOWS"
unzip -q -o "${FFMPEG_DIST_WINDOWS}.zip"
rm -rf "$BASEDIR/ffmpeg"
mkdir -p "$BASEDIR/ffmpeg/bin"
cp "$FFMPEG_DIST_WINDOWS/bin/ffmpeg.exe" "$BASEDIR/ffmpeg/bin/"
cp "$FFMPEG_DIST_WINDOWS/LICENSE" "$BASEDIR/ffmpeg/"
