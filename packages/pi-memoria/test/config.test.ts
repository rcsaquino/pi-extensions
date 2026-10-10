import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuration, managedRipgrepPath } from "../src/config.ts";

test("memory paths are global and configuration never accepts a project-relative directory", () => {
  assert.equal(configuration("/global/agent", {}).directory, join("/global/agent", "memoria"));
  assert.equal(configuration("~/custom-agent/../agent", { PI_MEMORIA_DIR: "/separate/memory" }).ripgrepPath,
    join(homedir(), "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg"));
  assert.throws(() => configuration("/global/agent", { PI_MEMORIA_DIR: ".pi/memory" }), /absolute path/u);
  assert.deepEqual(configuration("/global/agent", { PI_MEMORIA_SESSION_DIRS: '["/archive/one","/archive/two"]' }).sessionRoots,
    ["/global/agent/sessions", "/archive/one", "/archive/two"]);
  assert.throws(() => configuration("/global/agent", { PI_MEMORIA_SESSION_DIRS: '["relative"]' }), /absolute/u);
});

test("managed ripgrep paths use platform-native separators and executable names", () => {
  assert.equal(managedRipgrepPath("/custom/agent", "linux"), "/custom/agent/bin/rg");
  assert.equal(managedRipgrepPath("/custom/agent", "darwin"), "/custom/agent/bin/rg");
  assert.equal(managedRipgrepPath("C:\\Users\\Rey\\agent", "win32"), "C:\\Users\\Rey\\agent\\bin\\rg.exe");
  assert.equal(managedRipgrepPath("\\\\server\\share\\agent", "win32"), "\\\\server\\share\\agent\\bin\\rg.exe");
});
