#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

LIBREDWG_VERSION=0.14
LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
PKGCONF_VERSION=3.0.4
PKGCONF_SHA256=91ce346b47f46b87d680c6928e6c43240b9cdc7a31afbea19f2298de4dbe266d

usage() {
  echo "usage: $0 NEW_BUILD_DIRECTORY NEW_ADAPTER_PATH" >&2
  exit 2
}

fail() {
  echo "$1" >&2
  exit 1
}

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "a SHA-256 tool (shasum or sha256sum) is required"
  fi
}

verified_download() {
  url=$1
  destination=$2
  expected=$3
  curl --fail --location --silent --show-error "$url" --output "$destination"
  actual=$(checksum "$destination")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for downloaded source"
}

[ "$#" -eq 2 ] || usage

build_root=$1
adapter_output=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
adapter_parent=$(dirname -- "$adapter_output")

[ ! -e "$build_root" ] || fail "build directory already exists"
[ ! -e "$adapter_output" ] || fail "adapter output already exists"
[ -d "$adapter_parent" ] || fail "adapter output parent does not exist"

for required_tool in tar make awk patch "${STRIP:-strip}"; do
  command -v "$required_tool" >/dev/null 2>&1 \
    || fail "required build tool is missing: $required_tool"
done
command -v "${CC:-cc}" >/dev/null 2>&1 || fail "a C11 compiler is required"

jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2\n')
case $jobs in
  ''|*[!0-9]*) jobs=2 ;;
esac

mkdir -m 700 "$build_root"
install_prefix="$build_root/install"
tools_prefix="$build_root/tools"

pkg_config=
if command -v pkg-config >/dev/null 2>&1; then
  pkg_config=$(command -v pkg-config)
elif command -v pkgconf >/dev/null 2>&1; then
  pkg_config=$(command -v pkgconf)
else
  command -v curl >/dev/null 2>&1 \
    || fail "curl is required to download portable pkgconf"
  echo "Preparing portable pkgconf $PKGCONF_VERSION"
  pkgconf_archive="$build_root/pkgconf-$PKGCONF_VERSION.tar.xz"
  verified_download \
    "https://distfiles.ariadne.space/pkgconf/pkgconf-$PKGCONF_VERSION.tar.xz" \
    "$pkgconf_archive" \
    "$PKGCONF_SHA256"
  tar -xf "$pkgconf_archive" -C "$build_root"
  (
    cd "$build_root/pkgconf-$PKGCONF_VERSION"
    ./configure --prefix="$tools_prefix"
    make -j"$jobs"
    make install
  )
  pkg_config="$tools_prefix/bin/pkgconf"
fi

echo "Preparing GNU LibreDWG $LIBREDWG_VERSION"
if [ -n "${LIBREDWG_SOURCE_ARCHIVE:-}" ]; then
  [ -f "$LIBREDWG_SOURCE_ARCHIVE" ] \
    || fail "LIBREDWG_SOURCE_ARCHIVE is not a readable file"
  libredwg_archive=$LIBREDWG_SOURCE_ARCHIVE
  actual=$(checksum "$libredwg_archive")
  [ "$actual" = "$LIBREDWG_SHA256" ] \
    || fail "checksum mismatch for supplied LibreDWG source"
else
  command -v curl >/dev/null 2>&1 \
    || fail "curl is required to download LibreDWG source"
  libredwg_archive="$build_root/libredwg-$LIBREDWG_VERSION.tar.xz"
  verified_download \
    "https://github.com/LibreDWG/libredwg/releases/download/$LIBREDWG_VERSION/libredwg-$LIBREDWG_VERSION.tar.xz" \
    "$libredwg_archive" \
    "$LIBREDWG_SHA256"
fi
tar -xf "$libredwg_archive" -C "$build_root"

libredwg_source="$build_root/libredwg-$LIBREDWG_VERSION"
patch --batch --forward -d "$libredwg_source" -p1 \
  < "$script_dir/libredwg-acds-sab.patch"
patch --batch --forward -d "$libredwg_source" -p1 \
  < "$script_dir/libredwg-r2007-high-compression.patch"
(
  cd "$libredwg_source"
  PKG_CONFIG="$pkg_config" ./configure \
    --prefix="$install_prefix" \
    --disable-shared \
    --enable-static \
    --disable-bindings \
    --disable-docs \
    --disable-dxf \
    --disable-python \
    --disable-write
  make -j"$jobs" -C src libredwg.la
  make -C src install
  make install-includeHEADERS install-pcdataDATA
)

echo "Building process-isolated LibreDWG adapter"
LIBREDWG_PREFIX="$install_prefix" PKG_CONFIG="$pkg_config" \
  "$script_dir/build.sh" "$adapter_output"

printf 'LibreDWG %s adapter: %s\n' "$LIBREDWG_VERSION" "$adapter_output"
