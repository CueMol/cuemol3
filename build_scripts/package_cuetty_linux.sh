#!/bin/bash
#
# Package the portable Linux cuetty (headless umbreon rendering) as a tarball:
#
#   cuetty-<version>-linux-x64/
#     bin/cuetty
#     lib/libcuemol2.so*, libboost_*.so*
#     share/sysconfig_cuemol3.xml, sysconfig.xml, data/, icc_profiles/
#     README.md
#
# cuetty finds lib/ through its RPATH ($ORIGIN/../lib) and the config through
# its own location (../share/sysconfig_cuemol3.xml), so the tree runs from
# wherever it is unpacked, without LD_LIBRARY_PATH or --config.
#
# usage: package_cuetty_linux.sh <install_prefix> <out_dir> <version>
#   install_prefix: where libcuemol2 and cuetty were installed (.../cuemol2)
#

set -eux

if [ -z "${3:-}" ]; then
    echo "usage: package_cuetty_linux.sh <install_prefix> <out_dir> <version>"
    exit 1
fi

PREFIX=$1
OUTDIR=$2
VERSION=$3
REPOS_DIR=$(cd "$(dirname "$0")/.."; pwd)

NAME=cuetty-$VERSION-linux-x64
STAGE=$OUTDIR/$NAME

rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/share"

cp "$PREFIX/bin/cuetty" "$STAGE/bin/"
cp -P "$PREFIX"/lib/libcuemol2.so* "$STAGE/lib/"
cp -P "$PREFIX"/lib/libboost_*.so* "$STAGE/lib/"

cp "$PREFIX/share/sysconfig_cuemol3.xml" "$PREFIX/share/sysconfig.xml" "$STAGE/share/"
cp -R "$PREFIX/share/data" "$STAGE/share/"
if [ -d "$PREFIX/share/icc_profiles" ]; then
    cp -R "$PREFIX/share/icc_profiles" "$STAGE/share/"
fi

cp "$REPOS_DIR/cli/README.md" "$STAGE/README.md"

# Debug symbols are not shipped
strip --strip-unneeded "$STAGE/bin/cuetty"
find "$STAGE/lib" -type f -name '*.so*' -exec strip --strip-unneeded {} +

tar czf "$OUTDIR/$NAME.tar.gz" -C "$OUTDIR" "$NAME"
ls -lh "$OUTDIR/$NAME.tar.gz"
