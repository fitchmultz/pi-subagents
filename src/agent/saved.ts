import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { NativeJournal } from "../shared/native-journal.ts";
import { isRecord } from "../shared/unknown.ts";
import { Assert, Type } from "./typebox.ts";
import { thinkingSchema, successorSchema, type Launch } from "./contracts.ts";
import { packageRoot, runtimeEntry } from "./host.ts";
import { launchAt, read, runDirectory, safeId, write } from "./storage.ts";

const configuration = Type.Object({
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(thinkingSchema),
});
const contractSchema = Type.Object({
  sessionFile: Type.String({ minLength: 1 }),
  nativeSessionId: Type.Optional(Type.String()),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  effectiveConfiguration: Type.Optional(configuration),
  launch: Type.Object({
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(thinkingSchema),
    cwd: Type.String({ minLength: 1 }),
    context: Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
    projectTrusted: Type.Optional(Type.Boolean()),
  }),
});
const ownerSchema = Type.Object({ sessionId: Type.String() });
const singleSchema = Type.Object({
  ownerSessionId: Type.String(),
  mode: Type.Literal("single"),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  children: Type.Tuple([
    Type.Object({
      index: Type.Literal(0),
      sessionFile: Type.Optional(Type.String()),
    }),
  ]),
});
type Contract = Static<typeof contractSchema>;

function ownedRun(context: ExtensionContext, id: string) {
  const file = context.sessionManager.getSessionFile();
  if (file === undefined) {
    throw new Error("Legacy continuation requires a published native owner.");
  }
  const journal = new NativeJournal(file, "live");
  if (journal.records[0].value.id !== context.sessionManager.getSessionId()) {
    throw new Error("Native owner journal identity changed; nothing was launched.");
  }
  let owned;
  for (const record of journal.records) {
    if (record.value.type === "custom" && record.value.customType === "subagent-run") {
      const { data } = journal.body(record);
      if (isRecord(data) && data.runId === id) {
        owned = data;
      }
    }
  }
  if (owned?.ownerSessionId !== context.sessionManager.getSessionId()) {
    throw new Error("Missing saved native owner or foreign legacy run; nothing was launched.");
  }
  Assert(singleSchema, owned);
  return owned;
}
function requireExited(pid: unknown): void {
  if (pid === undefined) {
    return;
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Legacy process ownership is ambiguous; nothing was launched.");
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error("Legacy producer may still be live; refusing a second owner.");
}
function frozenModel(contract: Contract, context: ExtensionContext) {
  const model = contract.effectiveConfiguration?.model ?? contract.launch.model;
  const thinking = contract.effectiveConfiguration?.thinking ?? contract.launch.thinking;
  if (model === undefined || thinking === undefined || model.startsWith("claude-code/")) {
    throw new Error(
      "Missing native model/thinking snapshot or retired backend; nothing was launched.",
    );
  }
  const slash = model.indexOf("/");
  if (slash < 1 || !context.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) {
    throw new Error("Saved native model is unavailable; no fallback was used.");
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1), thinking };
}
function nativeSession(contract: Contract) {
  if (!path.isAbsolute(contract.sessionFile) || path.extname(contract.sessionFile) !== ".jsonl") {
    throw new Error("Legacy continuation requires the exact saved native journal.");
  }
  const journal = new NativeJournal(contract.sessionFile, "live");
  const sessionId = journal.body(journal.records[0]).id;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    (contract.nativeSessionId !== undefined && contract.nativeSessionId !== sessionId)
  ) {
    throw new Error("Saved native session identity does not match its contract.");
  }
  return { sessionFile: contract.sessionFile, sessionId };
}
function frozenSnapshot(
  source: string,
  context: ExtensionContext,
  owned: Static<typeof singleSchema>,
) {
  const contract = read(path.join(source, "contracts", "0.json"), contractSchema);
  if (!contract) {
    throw new Error("Missing frozen legacy launch; nothing was launched.");
  }
  const childFile = owned.children[0].sessionFile;
  if (
    fs
      .readdirSync(path.join(source, "contracts"))
      .some((file) => file.endsWith(".json") && file !== "0.json") ||
    (childFile !== undefined && childFile !== contract.sessionFile)
  ) {
    throw new Error("Ambiguous legacy child journal or multistep contract; nothing was launched.");
  }
  const cwd = contract.launch.cwd;
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error("Missing frozen legacy cwd; nothing was launched.");
  }
  requireExited(owned.pid);
  requireExited(contract.pid);
  return {
    ...frozenModel(contract, context),
    ...nativeSession(contract),
    cwd,
    context: contract.launch.context,
    trusted: contract.launch.projectTrusted === true,
  };
}

/** The committed adoption claim authorizes only its original owned journal. */
export function adoptedJournal(base: string, launch: Launch): boolean {
  const root = launchAt(base, launch.rootId, launch.owner);
  if (
    root.id !== root.rootId ||
    root.predecessor === undefined ||
    !path.isAbsolute(root.sessionFile) ||
    path.extname(root.sessionFile) !== ".jsonl" ||
    root.sessionFile !== launch.sessionFile ||
    root.sessionId !== launch.sessionId
  ) {
    return false;
  }
  return (
    read(path.join(base, `legacy-${safeId(root.predecessor)}.json`), successorSchema)?.id ===
    root.id
  );
}

/** Only frozen single-native-child snapshots cross the retired runtime boundary. */
export function savedContinuation(options: {
  id: string;
  prompt: string;
  context: ExtensionContext;
  base: string;
  agentDir: string;
}): { launch: Launch; created: boolean } {
  const { id, prompt, context, base, agentDir } = options;
  safeId(id);
  const owner = context.sessionManager.getSessionId();
  const owned = ownedRun(context, id);
  const source = path.join(agentDir, "sessions", "subagent-runs", id);
  if (read(path.join(source, "question-owner.json"), ownerSchema)?.sessionId !== owner) {
    throw new Error("Missing or foreign legacy owner; nothing was launched.");
  }
  const mapping = path.join(base, `legacy-${id}.json`);
  const adopted = read(mapping, successorSchema);
  if (adopted) {
    return { launch: launchAt(base, adopted.id, owner), created: false };
  }
  const snapshot = frozenSnapshot(source, context, owned);
  const nextId = randomUUID();
  const launch: Launch = {
    version: 1,
    id: nextId,
    rootId: nextId,
    predecessor: id,
    owner,
    agentDir,
    sdk: packageRoot(),
    entry: runtimeEntry(),
    prompt,
    ...snapshot,
    createdAt: Date.now(),
  };
  fs.mkdirSync(runDirectory(base, nextId), { mode: 0o700 });
  write(path.join(runDirectory(base, nextId), "launch.json"), launch, true);
  try {
    write(mapping, { id: nextId }, true);
  } catch (error) {
    fs.rmSync(runDirectory(base, nextId), { recursive: true });
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const winner = read(mapping, successorSchema);
    if (!winner) {
      throw new Error("Legacy continuation claim disappeared; refusing to replay.", {
        cause: error,
      });
    }
    return { launch: launchAt(base, winner.id, owner), created: false };
  }
  return { launch, created: true };
}
