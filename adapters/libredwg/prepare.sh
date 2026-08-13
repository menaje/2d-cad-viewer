#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

set -eu
umask 077

dispatch_fail() {
  echo "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case $(uname -s) in
  Darwin)
    platform_profile=macos
    ;;
  Linux)
    platform_profile=linux
    ;;
  MINGW*|MSYS*|CYGWIN*)
    platform_profile=windows
    ;;
  *)
    dispatch_fail "unsupported build platform: $(uname -s)"
    ;;
esac

profile_path="$script_dir/scripts/platform/$platform_profile.sh"
common_path="$script_dir/scripts/prepare-common.sh"
[ -r "$profile_path" ] || dispatch_fail "missing build platform profile"
[ -r "$common_path" ] || dispatch_fail "missing common build implementation"

# The profile owns only target-specific validation and configure flags. Source
# acquisition, patching, compilation, and adapter publication stay centralized.
. "$profile_path"
. "$common_path"

dwg_viewer_prepare "$@"
