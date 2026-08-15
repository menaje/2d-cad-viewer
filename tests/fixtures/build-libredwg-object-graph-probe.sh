#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later

set -eu
umask 077

LIBREDWG_VERSION=0.14

fail() {
  echo "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] \
  || fail "usage: LIBREDWG_PREFIX=ABSOLUTE_PREFIX $0 NEW_PROBE_PATH"
[ -n "${LIBREDWG_PREFIX:-}" ] \
  || fail "LIBREDWG_PREFIX is required"

output_path=$1
output_parent=$(dirname -- "$output_path")
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cc=${CC:-cc}
pkg_config=${PKG_CONFIG:-}

[ -d "$LIBREDWG_PREFIX" ] || fail "LibreDWG prefix is not a directory"
[ -d "$output_parent" ] || fail "probe output parent does not exist"
[ ! -e "$output_path" ] || fail "probe output already exists"
command -v "$cc" >/dev/null 2>&1 || fail "a C11 compiler is required"

if [ -n "$pkg_config" ]; then
  :
elif [ -x "$LIBREDWG_PREFIX/bin/pkg-config" ]; then
  pkg_config="$LIBREDWG_PREFIX/bin/pkg-config"
elif [ -x "$LIBREDWG_PREFIX/../tools/bin/pkgconf" ]; then
  pkg_config="$LIBREDWG_PREFIX/../tools/bin/pkgconf"
elif command -v pkg-config >/dev/null 2>&1; then
  pkg_config=$(command -v pkg-config)
elif command -v pkgconf >/dev/null 2>&1; then
  pkg_config=$(command -v pkgconf)
else
  fail "pkg-config is required"
fi
[ -x "$pkg_config" ] || fail "pkg-config is not executable"

if [ "$(uname -s)" = Darwin ] \
  && [ -d "$LIBREDWG_PREFIX/../tools/lib" ]; then
  DYLD_LIBRARY_PATH="$LIBREDWG_PREFIX/../tools/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  export DYLD_LIBRARY_PATH
fi

PKG_CONFIG_PATH="$LIBREDWG_PREFIX/lib/pkgconfig:$LIBREDWG_PREFIX/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export PKG_CONFIG_PATH

pkg_config_query() {
  "$pkg_config" "--define-variable=prefix=$LIBREDWG_PREFIX" "$@"
}

pkg_config_query --exact-version="$LIBREDWG_VERSION" libredwg
if [ -f "$LIBREDWG_PREFIX/lib/libredwg.a" ]; then
  static_library="$LIBREDWG_PREFIX/lib/libredwg.a"
elif [ -f "$LIBREDWG_PREFIX/lib64/libredwg.a" ]; then
  static_library="$LIBREDWG_PREFIX/lib64/libredwg.a"
else
  static_library=
fi
[ -f "$static_library" ] || fail "static LibreDWG library is missing"
[ -f "$LIBREDWG_PREFIX/include/dwg.h" ] \
  || fail "LibreDWG development headers are missing"

"$cc" -std=c11 -O2 -g -Wall -Wextra -Wpedantic \
  -I"$LIBREDWG_PREFIX/include" -pthread \
  "$script_dir/libredwg-object-graph-probe.c" \
  "$static_library" -lm -pthread -o "$output_path"
chmod 700 "$output_path"
