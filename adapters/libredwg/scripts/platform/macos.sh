#!/bin/sh
# SPDX-License-Identifier: MPL-2.0

dwg_viewer_platform_configure() {
  case $(uname -m) in
    x86_64|arm64)
      ;;
    *)
      fail "unsupported macOS build architecture: $(uname -m)"
      ;;
  esac
  dwg_viewer_profile_pkg_config=$1
  shift
  CFLAGS=${CFLAGS:--O3 -DNDEBUG} \
    PKG_CONFIG="$dwg_viewer_profile_pkg_config" \
    "$@"
}
