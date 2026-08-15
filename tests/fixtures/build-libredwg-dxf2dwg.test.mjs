// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("requests the platform executable target from LibreDWG makefiles", async () => {
  const script = await readFile(
    new URL("./build-libredwg-dxf2dwg.sh", import.meta.url),
    "utf8",
  );

  assert.match(
    script,
    /MINGW\*\|MSYS\*\|CYGWIN\*\) program_target=dxf2dwg\.exe/u,
  );
  assert.match(
    script,
    /make -j"\$jobs" -C programs "\$program_target"/u,
  );
  assert.match(
    script,
    /built_path="\$source_root\/programs\/\$program_target"/u,
  );
  assert.doesNotMatch(
    script,
    /make -j"\$jobs" -C programs dxf2dwg(?:\r?\n|\s)/u,
  );
});
