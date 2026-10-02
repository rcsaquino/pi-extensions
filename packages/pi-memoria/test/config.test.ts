import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { configuration } from "../src/config.ts";

test("memory paths are global and configuration never accepts a project-relative directory", () => {
  assert.equal(configuration("/global/agent", {}).directory, join("/global/agent", "memoria"));
  assert.throws(() => configuration("/global/agent", { PI_MEMORIA_DIR: ".pi/memory" }), /absolute path/u);
  assert.deepEqual(configuration("/global/agent", { PI_MEMORIA_SESSION_DIRS: '["/archive/one","/archive/two"]' }).sessionRoots,
    ["/global/agent/sessions", "/archive/one", "/archive/two"]);
  assert.throws(() => configuration("/global/agent", { PI_MEMORIA_SESSION_DIRS: '["relative"]' }), /absolute/u);
});
