#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

LIBREDWG_VERSION=0.14
LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
PKGCONF_VERSION=3.0.4
PKGCONF_SHA256=91ce346b47f46b87d680c6928e6c43240b9cdc7a31afbea19f2298de4dbe266d
EMSDK_VERSION=4.0.15
EMSDK_IMAGE=emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8

usage() {
  echo "usage: $0 NEW_BUILD_DIRECTORY NEW_OUTPUT_DIRECTORY" >&2
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

verified_source() {
  supplied=$1
  url=$2
  destination=$3
  expected=$4
  label=$5
  if [ -n "$supplied" ]; then
    [ -f "$supplied" ] || fail "$label source archive is not a readable file"
    cp "$supplied" "$destination"
  else
    curl --fail --location --silent --show-error \
      "$url" --output "$destination"
  fi
  actual=$(checksum "$destination")
  [ "$actual" = "$expected" ] || fail "$label source checksum mismatch"
}

[ "$#" -eq 2 ] || usage

build_root=$1
output_root=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
adapter_dir=$(dirname -- "$script_dir")

[ ! -e "$build_root" ] || fail "build directory already exists"
[ ! -e "$output_root" ] || fail "output directory already exists"
[ -d "$(dirname -- "$build_root")" ] || fail "build parent does not exist"
[ -d "$(dirname -- "$output_root")" ] || fail "output parent does not exist"

for required_tool in docker curl tar awk; do
  command -v "$required_tool" >/dev/null 2>&1 \
    || fail "required build tool is missing: $required_tool"
done

mkdir -m 700 "$build_root"
mkdir -m 700 "$output_root"

verified_source \
  "${LIBREDWG_SOURCE_ARCHIVE:-}" \
  "https://github.com/LibreDWG/libredwg/releases/download/$LIBREDWG_VERSION/libredwg-$LIBREDWG_VERSION.tar.xz" \
  "$build_root/libredwg-$LIBREDWG_VERSION.tar.xz" \
  "$LIBREDWG_SHA256" \
  "LibreDWG"
verified_source \
  "${PKGCONF_SOURCE_ARCHIVE:-}" \
  "https://distfiles.ariadne.space/pkgconf/pkgconf-$PKGCONF_VERSION.tar.xz" \
  "$build_root/pkgconf-$PKGCONF_VERSION.tar.xz" \
  "$PKGCONF_SHA256" \
  "pkgconf"

echo "Building LibreDWG $LIBREDWG_VERSION with Emscripten $EMSDK_VERSION"
docker run --rm --platform linux/amd64 \
  -e "LIBREDWG_VERSION=$LIBREDWG_VERSION" \
  -e "PKGCONF_VERSION=$PKGCONF_VERSION" \
  -v "$build_root:/work" \
  -v "$output_root:/output" \
  -v "$adapter_dir:/adapter:ro" \
  -w /work \
  "$EMSDK_IMAGE" \
  sh -lc '
    set -eu
    jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf "2\n")
    case $jobs in
      ""|*[!0-9]*) jobs=2 ;;
    esac

    tar -xf "pkgconf-$PKGCONF_VERSION.tar.xz"
    (
      cd "pkgconf-$PKGCONF_VERSION"
      ./configure --prefix=/work/tools
      make -s -j"$jobs"
      make -s install
    )
    PATH="/work/tools/bin:$PATH"
    export PATH

    tar -xf "libredwg-$LIBREDWG_VERSION.tar.xz"
    patch --batch --forward -d "libredwg-$LIBREDWG_VERSION" -p1 \
      < /adapter/libredwg-acds-sab.patch
    patch --batch --forward -d "libredwg-$LIBREDWG_VERSION" -p1 \
      < /adapter/libredwg-r2007-high-compression.patch
    patch --batch --forward -d "libredwg-$LIBREDWG_VERSION" -p1 \
      < /adapter/libredwg-seekable-stdin.patch
    (
      cd "libredwg-$LIBREDWG_VERSION"
      PKG_CONFIG=/work/tools/bin/pkgconf emconfigure ./configure \
        --prefix=/work/install \
        --disable-shared \
        --enable-static \
        --disable-bindings \
        --disable-docs \
        --disable-dxf \
        --disable-python \
        --disable-write
      emmake make -s -j"$jobs" -C src libredwg.la
      emmake make -s -C src install
      emmake make -s install-includeHEADERS install-pcdataDATA
    )

    /work/tools/bin/pkgconf \
      --with-path=/work/install/lib/pkgconfig \
      --exact-version="$LIBREDWG_VERSION" libredwg

    emcc -std=c11 -O3 -DNDEBUG -Wall -Wextra -Wpedantic \
      "-DDWG_VIEWER_LIBREDWG_VERSION=\"$LIBREDWG_VERSION\"" \
      -DDWG_VIEWER_LIBREDWG_LINKAGE=\"static-wasm\" \
      -I/work/install/include \
      /adapter/libredwg_adapter.c \
      /adapter/libredwg_scene_cache.c \
      /work/install/lib/libredwg.a \
      -lm \
      -sMODULARIZE=1 \
      -sEXPORT_NAME=createLibreDwgModule \
      -sINVOKE_RUN=0 \
      -sEXIT_RUNTIME=0 \
      -sALLOW_MEMORY_GROWTH=1 \
      -sMAXIMUM_MEMORY=2147483648 \
      -sFORCE_FILESYSTEM=1 \
      -sENVIRONMENT=node,worker \
      -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8 \
      -o /output/libredwg-wasm.js
  '

chmod 0644 \
  "$output_root/libredwg-wasm.js" \
  "$output_root/libredwg-wasm.wasm"

printf 'JavaScript SHA-256: %s\n' \
  "$(checksum "$output_root/libredwg-wasm.js")"
printf 'WebAssembly SHA-256: %s\n' \
  "$(checksum "$output_root/libredwg-wasm.wasm")"
printf 'Qualification output: %s\n' "$output_root"
