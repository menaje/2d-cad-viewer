#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

fail() {
  echo "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] \
  || fail "usage: $0 LIBREDWG_SOURCE_ARCHIVE NEW_BUILD_DIRECTORY NEW_ADAPTER_PATH"

source_archive=$1
build_root=$2
adapter_path=$3
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cc=${CC:-cc}

[ "$(uname -s)" = Darwin ] \
  || fail "the checked-in sanitizer profile is qualified only on macOS"
[ -f "$source_archive" ] || fail "LibreDWG source archive is not readable"
[ ! -e "$build_root" ] || fail "build directory already exists"
[ ! -e "$adapter_path" ] || fail "adapter output already exists"
[ -d "$(dirname -- "$adapter_path")" ] \
  || fail "adapter output parent does not exist"
command -v "$cc" >/dev/null 2>&1 || fail "a C11 compiler is required"

sanitizer_flags="-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer"
LIBREDWG_SOURCE_ARCHIVE="$source_archive" \
  CC="$cc" \
  CFLAGS="$sanitizer_flags" \
  LDFLAGS="-fsanitize=address,undefined" \
  STRIP=: \
  "$repository_root/adapters/libredwg/prepare.sh" \
  "$build_root" "$adapter_path"

printf 'Sanitized LibreDWG adapter: %s\n' "$adapter_path"
