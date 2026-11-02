import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe as nodeDescribe, it as nodeIt, mock } from "node:test";
import { resolveTempRootDir, resolveTempScopeId } from "../../src/shared/types.ts";

nodeDescribe("resolveTempScopeId", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const key of ["USERNAME", "USER", "LOGNAME", "HOME"]) {
      delete process.env[key];
    }
  });
  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of ["USERNAME", "USER", "LOGNAME", "HOME"]) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  nodeIt("prefers uid when available", () => {
    mock.property(process, "getuid", () => 501);
    process.env.USER = "alice";
    assert.equal(resolveTempScopeId(), "uid-501");
  });

  nodeIt("falls back to environment usernames when uid is unavailable", () => {
    mock.property(process, "getuid", undefined);
    process.env.USERNAME = "Alice Example";
    assert.equal(resolveTempScopeId(), "user-Alice-Example");
  });

  nodeIt("falls back to os.userInfo when environment is missing", () => {
    mock.property(process, "getuid", undefined);
    mock.method(os, "userInfo", () => ({ username: "svc_account" }));
    syncBuiltinESMExports();
    assert.equal(resolveTempScopeId(), "user-svc_account");
  });

  nodeIt("falls back to home path when os.userInfo throws", () => {
    mock.property(process, "getuid", undefined);
    mock.method(os, "userInfo", () => {
      throw new Error("uv_os_get_passwd returned ENOENT");
    });
    mock.method(os, "homedir", () => "/home/12345/app user");
    syncBuiltinESMExports();
    assert.equal(resolveTempScopeId(), "home-home-12345-app-user");
  });
});

nodeDescribe("resolveTempRootDir", () => {
  nodeIt("accepts only dedicated pi-subagents directories", () => {
    assert.equal(resolveTempRootDir(), process.env.PI_SUBAGENT_TEMP_ROOT);
    assert.equal(
      resolveTempRootDir("/tmp/pi-subagents-isolated"),
      path.resolve("/tmp/pi-subagents-isolated"),
    );
    assert.throws(() => resolveTempRootDir("/tmp"), /dedicated 'pi-subagents-\*' directory/);
    assert.throws(() => resolveTempRootDir("/"), /dedicated 'pi-subagents-\*' directory/);
  });
});
