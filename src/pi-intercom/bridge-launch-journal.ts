import { statSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadNativeSession } from "../shared/native-session-loader.ts";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import { Fault, cancelled, wait } from "./bridge-protocol.ts";
import { trustedJournal, inspectResumeIdentity } from "./bridge-catalog.ts";
import { nativePeerId } from "./session-targets.ts";
import type { LaunchPolicy } from "./bridge-launch-policy.ts";

export interface LaunchJournal {
  readonly sessionId: string;
  readonly peerId: string;
  readonly sessionFile: string;
  readonly name?: string;
  readonly cwd: string;
  readonly model?: { readonly provider: string; readonly modelId: string };
}
export function validateLaunchState(saved: LaunchJournal, state: UnknownRecord): void {
  if (
    state.sessionId !== saved.sessionId ||
    state.sessionFile !== saved.sessionFile ||
    state.sessionName !== saved.name ||
    state.isStreaming !== false ||
    state.pendingMessageCount !== 0 ||
    !isRecord(state.model)
  ) {
    throw new Fault(503, "readiness_failed", "Pi did not start idle with the exact saved session.");
  }
  if (
    saved.model &&
    (state.model.provider !== saved.model.provider || state.model.id !== saved.model.modelId)
  ) {
    throw new Fault(
      503,
      "model_restore_failed",
      "Pi could not restore the saved model exactly; no task submitted and no silent fallback allowed.",
    );
  }
}
function journal(manager: Readonly<SessionManager>): LaunchJournal {
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Fault(503, "journal_invalid", "Native journal was not persisted.");
  }
  const branch = manager.getBranch();
  const change = branch.findLast((entry) => entry.type === "model_change");
  const model =
    change?.type === "model_change"
      ? { provider: change.provider, modelId: change.modelId }
      : (manager.buildSessionContext().model ?? undefined);
  return {
    sessionId: manager.getSessionId(),
    peerId: nativePeerId(manager.getSessionId()),
    sessionFile,
    name: manager.getSessionName(),
    cwd: manager.getCwd(),
    model,
  };
}
export async function createLaunchJournal(
  policy: LaunchPolicy,
  target: { readonly cwd: string; readonly name: string },
  signal: AbortSignal,
): Promise<LaunchJournal> {
  const { SessionManager: Manager } = await wait(loadNativeSession(policy.packageRoot), signal);
  cancelled(signal);
  const storage = statSync(policy.sessionDir);
  if (
    !storage.isDirectory() ||
    storage.uid !== process.getuid?.() ||
    (storage.mode & 0o777) !== 0o700
  ) {
    throw new Fault(503, "storage_invalid", "Private launch storage is no longer valid.");
  }
  const previous = process.umask(0o077);
  try {
    const manager = Manager.create(target.cwd, policy.sessionDir);
    manager.appendSessionInfo(target.name);
    if (policy.provider !== undefined && policy.model !== undefined) {
      manager.appendModelChange(policy.provider, policy.model);
    }
    manager.appendMessage({ role: "user", content: policy.context, timestamp: Date.now() });
    const result = journal(manager);
    trustedJournal(policy, result.sessionFile);
    if ((statSync(result.sessionFile).mode & 0o777) !== 0o600) {
      throw new Fault(503, "journal_invalid", "New native journal was not privately persisted.");
    }
    return result;
  } finally {
    process.umask(previous);
  }
}
export async function resumeLaunchJournal(
  policy: LaunchPolicy,
  saved: LaunchJournal,
  signal: AbortSignal,
): Promise<LaunchJournal> {
  const sdk = await wait(loadNativeSession(policy.packageRoot), signal);
  cancelled(signal);
  trustedJournal(policy, saved.sessionFile);
  validateResumeIdentity(saved, await inspectResumeIdentity(saved.sessionFile, sdk, signal));
  cancelled(signal);
  const result = journal(sdk.SessionManager.open(saved.sessionFile));
  validateResumeIdentity(saved, result);
  return result;
}
function validateResumeIdentity(
  saved: LaunchJournal,
  actual: Pick<LaunchJournal, "sessionId" | "cwd" | "name">,
): void {
  if (
    actual.sessionId !== saved.sessionId ||
    actual.cwd !== saved.cwd ||
    actual.name !== saved.name
  ) {
    throw new Fault(
      409,
      "journal_changed",
      "Native session identity changed while preparing resume.",
    );
  }
}
