#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

LIBREDWG_VERSION=0.14
LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
PKGCONF_VERSION=3.0.4
PKGCONF_SHA256=91ce346b47f46b87d680c6928e6c43240b9cdc7a31afbea19f2298de4dbe266d

fail() {
  echo "$1" >&2
  exit 1
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "a SHA-256 tool (shasum or sha256sum) is required"
  fi
}

[ "$#" -eq 3 ] \
  || fail "usage: $0 LIBREDWG_SOURCE_ARCHIVE NEW_BUILD_DIRECTORY NEW_DXF2DWG_PATH"

source_archive=$1
build_root=$2
output_path=$3
output_parent=$(dirname -- "$output_path")

[ -f "$source_archive" ] || fail "LibreDWG source archive is not readable"
[ ! -e "$build_root" ] || fail "build directory already exists"
[ ! -e "$output_path" ] || fail "fixture writer output already exists"
[ -d "$output_parent" ] || fail "fixture writer output parent does not exist"
[ "$(checksum "$source_archive")" = "$LIBREDWG_SHA256" ] \
  || fail "LibreDWG source checksum mismatch"

for tool in tar make awk "${CC:-cc}"; do
  command -v "$tool" >/dev/null 2>&1 || fail "required build tool is missing: $tool"
done

pkg_config=${PKG_CONFIG:-}
if [ -z "$pkg_config" ]; then
  if command -v pkg-config >/dev/null 2>&1; then
    pkg_config=$(command -v pkg-config)
  elif command -v pkgconf >/dev/null 2>&1; then
    pkg_config=$(command -v pkgconf)
  fi
fi

jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2\n')
case $jobs in
  ''|*[!0-9]*) jobs=2 ;;
esac
if [ "$jobs" -gt 8 ]; then
  jobs=8
fi

mkdir -m 700 "$build_root"
pkg_config_works=false
case $pkg_config in
  *' '*|*"	"*) ;;
  "") ;;
  *)
    if [ -x "$pkg_config" ] \
      && "$pkg_config" --atleast-pkgconfig-version 0.9.0 >/dev/null 2>&1; then
      pkg_config_works=true
    fi
    ;;
esac
if [ "$pkg_config_works" != true ]; then
  archive_parent=$(CDPATH= cd -- "$(dirname -- "$source_archive")" && pwd)
  pkgconf_archive=${PKGCONF_SOURCE_ARCHIVE:-$archive_parent/pkgconf-$PKGCONF_VERSION.tar.xz}
  [ -f "$pkgconf_archive" ] \
    || fail "pkg-config or the checksum-pinned pkgconf source archive is required"
  [ "$(checksum "$pkgconf_archive")" = "$PKGCONF_SHA256" ] \
    || fail "pkgconf source checksum mismatch"
  tar -xf "$pkgconf_archive" -C "$build_root"
  (
    cd "$build_root/pkgconf-$PKGCONF_VERSION"
    ./configure \
      --prefix="$build_root/pkgconf-install" \
      --disable-shared \
      --enable-static
    make -j"$jobs"
    make install
  )
  pkg_config="$build_root/pkgconf-install/bin/pkgconf"
fi
tar -xf "$source_archive" -C "$build_root"
source_root="$build_root/libredwg-$LIBREDWG_VERSION"

(
  cd "$source_root"
  CFLAGS=${CFLAGS:--O2 -DNDEBUG} PKG_CONFIG="$pkg_config" ./configure \
    --disable-shared \
    --enable-static \
    --disable-bindings \
    --disable-docs \
    --disable-python
  make -j"$jobs" -C src libredwg.la
  make -j"$jobs" -C programs dxf2dwg
)

case $(uname -s) in
  MINGW*|MSYS*|CYGWIN*) built_path="$source_root/programs/dxf2dwg.exe" ;;
  *) built_path="$source_root/programs/dxf2dwg" ;;
esac
[ -x "$built_path" ] || fail "LibreDWG fixture writer was not built"
cp "$built_path" "$output_path"
chmod 700 "$output_path"
printf 'LibreDWG %s fixture writer: %s\n' "$LIBREDWG_VERSION" "$output_path"
