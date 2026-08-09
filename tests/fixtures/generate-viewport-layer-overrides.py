#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

import argparse
from pathlib import Path

import ezdxf
from ezdxf.colors import RGB


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the synthetic viewport-layer-override DXF fixture.",
    )
    parser.add_argument("output", type=Path, help="new absolute .dxf path")
    arguments = parser.parse_args()
    if not arguments.output.is_absolute():
        parser.error("output must be an absolute path")
    if arguments.output.suffix.lower() != ".dxf":
        parser.error("output must use the .dxf extension")
    if arguments.output.exists():
        parser.error("output must not already exist")
    if not arguments.output.parent.is_dir():
        parser.error("output parent directory must already exist")
    return arguments


def main() -> None:
    arguments = parse_arguments()
    document = ezdxf.new("R2004", setup=False)
    document.layers.add(
        "TARGET",
        color=7,
        linetype="Continuous",
        lineweight=25,
    )
    document.linetypes.add(
        "DASHED",
        pattern=[0.5, 0.25, -0.25],
        length=0.5,
        description="Viewport override test",
    )
    document.modelspace().add_line(
        (0, 0),
        (100, 0),
        dxfattribs={"layer": "TARGET"},
    )

    layout = document.layout("Layout1")
    viewport = layout.add_viewport(
        center=(100, 75),
        size=(180, 120),
        view_center_point=(50, 0),
        view_height=50,
        dxfattribs={"layer": "0"},
    )
    overrides = document.layers.get("TARGET").get_vp_overrides()
    overrides.set_rgb(viewport.dxf.handle, RGB(17, 34, 51))
    overrides.set_transparency(viewport.dxf.handle, 0.4)
    overrides.set_linetype(viewport.dxf.handle, "DASHED")
    overrides.set_lineweight(viewport.dxf.handle, 50)
    overrides.commit()

    document.saveas(arguments.output)
    print(f"DXF={arguments.output}")
    print(f"VIEWPORT_HANDLE={viewport.dxf.handle}")


if __name__ == "__main__":
    main()
