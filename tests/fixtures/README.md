# Test fixtures

Only synthetic drawings or drawings with explicit redistribution permission
may be committed here. Private working drawings belong outside this directory
and are ignored by the repository-level `test files/` rule.

## Viewport layer overrides

`generate-viewport-layer-overrides.py` creates the source definition for the
four-property viewport override qualification. It requires the pinned optional
fixture dependency `ezdxf==1.4.2` and refuses to overwrite an output file:

```bash
PYTHONPATH=/absolute/path/to/ezdxf-1.4.2 \
  python3 tests/fixtures/generate-viewport-layer-overrides.py \
  /absolute/new/path/viewport-layer-overrides-r2004.dxf
```

Encode that DXF as an R2004 DWG with a separate trusted fixture converter, then
pass the DWG to `pnpm run qualify:viewport-layer-overrides`. Neither the
write-enabled converter nor its output is part of the product package. The
source definition contains only generated geometry and has no private drawing
content. `Layout1` contains a paper viewport and one model viewport so the
qualification exercises the final layout composition path, not only sparse
override metadata.
