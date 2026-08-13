#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu

LIBREDWG_VERSION=0.14

usage() {
  echo "usage: LIBREDWG_PREFIX=/path/to/prefix $0 OUTPUT" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
[ -n "${LIBREDWG_PREFIX:-}" ] || usage

output=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pkg_config=${PKG_CONFIG:-pkg-config}
cc=${CC:-cc}
strip=${STRIP:-strip}
build_cflags=${CFLAGS:--O3 -DNDEBUG}
build_ldflags=${LDFLAGS:-}

[ ! -e "$output" ] || {
  echo "refusing to overwrite adapter output: $output" >&2
  exit 1
}
command -v "$strip" >/dev/null 2>&1 || {
  echo "a binary strip tool is required: $strip" >&2
  exit 1
}

if [ -x "$LIBREDWG_PREFIX/bin/pkg-config" ]; then
  pkg_config="$LIBREDWG_PREFIX/bin/pkg-config"
fi

PKG_CONFIG_PATH="$LIBREDWG_PREFIX/lib/pkgconfig:$LIBREDWG_PREFIX/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export PKG_CONFIG_PATH

"$pkg_config" --exact-version="$LIBREDWG_VERSION" libredwg
engine_version=$("$pkg_config" --modversion libredwg)
cflags=$("$pkg_config" --cflags libredwg)
libdir=$("$pkg_config" --variable=libdir libredwg)
static_library="$libdir/libredwg.a"
platform_cflags=
platform_ldflags=

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    platform_ldflags="-static -static-libgcc"
    ;;
  *)
    platform_cflags="-pthread"
    platform_ldflags="-pthread"
    ;;
esac

[ -f "$static_library" ] || {
  echo "the portable build requires the static LibreDWG library: $static_library" >&2
  exit 1
}

# Build flags and pkg-config output are intentionally split into compiler
# arguments. The defaults remain the release profile; explicit CFLAGS/LDFLAGS
# let the local sanitizer qualification link the same adapter boundary.
# shellcheck disable=SC2086
"$cc" -std=c11 $build_cflags -Wall -Wextra -Wpedantic \
  "-DDWG_VIEWER_LIBREDWG_VERSION=\"$engine_version\"" \
  '-DDWG_VIEWER_LIBREDWG_LINKAGE="static"' \
  $cflags $platform_cflags \
  "$script_dir/libredwg_adapter.c" \
  "$script_dir/libredwg_scene_cache.c" \
  "$static_library" -lm $platform_ldflags $build_ldflags -o "$output"

"$strip" "$output"
