#!/bin/bash
#
# Check the portable Linux cuetty tarball on the machine (container) it runs
# on: unpack it and render with no LD_LIBRARY_PATH and no --config, as a user
# on a cluster node would.
#
#   - a still image of a scene with an xz-embedded molecule, which must not be
#     background only (the embedded data was actually read);
#   - the scene's animation in two shards written to separate directories,
#     each of which must hold exactly the frames of its own range (a shard
#     that rendered every frame, or none, fails);
#   - four shards started at once into one new directory, which together
#     must leave every frame.
#
# Pixel values are not compared: they change with every umbreon change.
#
# usage: check_cuetty_portable.sh <tarball> <scene.qsc>
#

set -eux

if [ -z "${2:-}" ]; then
    echo "usage: check_cuetty_portable.sh <tarball> <scene.qsc>"
    exit 1
fi

TARBALL=$1
SCENE=$2

unset LD_LIBRARY_PATH
WORK=$(mktemp -d)
tar xzf "$TARBALL" -C "$WORK"
CUETTY=$(ls -d "$WORK"/cuetty-*/bin/cuetty)

# Still image. A 64x64 PNG of the background alone is ~200 bytes; with the
# molecule it is several kB.
"$CUETTY" --input "$SCENE" --render "$WORK/still.png" --width 64 --height 64
SIZE=$(wc -c < "$WORK/still.png")
if [ "$SIZE" -lt 1000 ]; then
    echo "ERROR: still.png is $SIZE bytes; the molecule seems to be missing" >&2
    exit 1
fi

# Movie in two shards. 1 s at 8 fps = frames 0-8: shard 0/2 is 0-4, 1/2 is 5-8.
MOVIE_OPTS=(--input "$SCENE" --fps 8 --width 64 --height 64)
"$CUETTY" "${MOVIE_OPTS[@]}" --list-frames --shard 0/2
"$CUETTY" "${MOVIE_OPTS[@]}" --movie "$WORK/s0/movie" --shard 0/2
"$CUETTY" "${MOVIE_OPTS[@]}" --movie "$WORK/s1/movie" --shard 1/2

expect_frames()
{
    local dir=$1 first=$2 last=$3
    local expected actual
    expected=$(for ((i = first; i <= last; i++)); do printf 'movie_frm_%04d.png\n' $i; done)
    actual=$(ls "$dir")
    if [ "$expected" != "$actual" ]; then
        echo "ERROR: $dir holds" $actual "but should hold frames $first-$last" >&2
        exit 1
    fi
}
expect_frames "$WORK/s0" 0 4
expect_frames "$WORK/s1" 5 8

# An array job starts its tasks together, and they all create the same
# output directory: start four shards at once into one that does not exist
# yet. (This catches the race only when the timing hits it, as it did on a
# real cluster; it never fails a correct build.)
pids=()
for i in 0 1 2 3; do
    "$CUETTY" "${MOVIE_OPTS[@]}" --movie "$WORK/shared/sub/movie" --shard $i/4 &
    pids+=($!)
done
for pid in "${pids[@]}"; do
    wait "$pid"
done
expect_frames "$WORK/shared/sub" 0 8

rm -rf "$WORK"
echo "cuetty portable check: OK"
