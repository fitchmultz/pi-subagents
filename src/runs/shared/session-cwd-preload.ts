import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importSelectedNative } from "../../shared/native-import.ts";
import { isRecord as isObject } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import { optionalString, requiredString } from "./child-message-validation.ts";

// Node loads this before Pi selects its session and creates cwd-bound services.
// Use the SDK beside the actual CLI (bundled or unbundled), never our dev peer.
const configuration = process.env.PI_SUBAGENT_SESSION_CWD;
if (nonempty(configuration)) {
  const value: unknown = JSON.parse(configuration);
  if (!isObject(value)) {
    throw new Error("Invalid native session cwd override");
  }
  const sessionFile = requiredString(value.sessionFile, "sessionFile");
  const cwd = requiredString(value.cwd, "cwd");
  const nodeOptions = optionalString(value.nodeOptions, "nodeOptions");
  const entry = process.argv.at(1);
  if (entry === undefined) {
    throw new Error("Native Pi CLI entry point is missing");
  }
  const sdkUrl = pathToFileURL(join(dirname(realpathSync(entry)), "index.js"));
  const { SessionManager } = await importSelectedNative(
    import.meta.url,
    "@earendil-works/pi-coding-agent",
    sdkUrl.href,
    () => import("@earendil-works/pi-coding-agent"),
  );
  const open = SessionManager.open.bind(SessionManager);
  SessionManager.open = (file, sessionDir, cwdOverride) => {
    if (resolve(file) !== sessionFile) {
      return open(file, sessionDir, cwdOverride);
    }
    SessionManager.open = open;
    // Keep preload through a native launcher, then clear it before tools or nested children start.
    delete process.env.PI_SUBAGENT_SESSION_CWD;
    if (nodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = nodeOptions;
    }
    // Public SDK override preserves the file, header, identity and history.
    return open(file, sessionDir, cwd);
  };
}
