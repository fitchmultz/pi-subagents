import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  bool,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  tuple,
  type Static,
} from "@earendil-works/pi-schema";
import { NativeJournal } from "../shared/native-journal.ts";
import { assertValid } from "../shared/schema.ts";
import { isRecord } from "../shared/unknown.ts";
import { thinkingSchema, successorSchema, type Launch, type OverseerLaunch } from "./contracts.ts";
import { packageRoot, runtimeEntry } from "./host.ts";
import { launchAt, read, runDirectory, safeId, write } from "./storage.ts";

const configuration = obj(
  {
    model: opt(str()),
    thinking: opt(thinkingSchema),
  },
  { open: true },
);
const contractSchema = obj(
  {
    sessionFile: str({ minLength: 1 }),
    nativeSessionId: opt(str()),
    pid: opt(int({ minimum: 1 })),
    effectiveConfiguration: opt(configuration),
    launch: obj(
      {
        model: opt(str()),
        thinking: opt(thinkingSchema),
        cwd: str({ minLength: 1 }),
        context: oneOf(["fresh", "fork"]),
        projectTrusted: opt(bool()),
      },
      { open: true },
    ),
  },
  { open: true },
);
const ownerSchema = obj({ sessionId: str() }, { open: true });
const singleSchema = obj(
  {
    ownerSessionId: str(),
    mode: lit("single"),
    pid: opt(int({ minimum: 1 })),
    children: tuple([
      obj(
        {
          index: lit(0),
          sessionFile: opt(str()),
        },
        { open: true },
      ),
    ]),
  },
  { open: true },
);
const singleValidator = compile(singleSchema);
type Contract = Static<typeof contractSchema>;

function ownedRun(context: ExtensionContext, id: string) {
  const file = context.sessionManager.getSessionFile();
  if (file === undefined) {
    throw new Error("Legacy continuation requires a published native owner.");
  }
  const journal = new NativeJournal(file, "live");
  const [opening] = journal.records;
  if (opening === undefined || opening.value.id !== context.sessionManager.getSessionId()) {
    throw new Error("Native owner journal identity changed; nothing was launched.");
  }
  const owned = findOwnedRun(journal, id);
  if (owned === undefined) {
    throw new Error(
      `Missing saved native owner run; nothing was launched. Requested id: ${JSON.stringify(id)}. Use agent_runs with action: "list" and copy the exact full run UUID.`,
    );
  }
  if (owned.ownerSessionId !== context.sessionManager.getSessionId()) {
    throw new Error(
      `Foreign legacy run belongs to another session; this session cannot continue it. Requested id: ${JSON.stringify(id)}.`,
    );
  }
  assertValid(singleValidator, owned);
  return owned;
}

function findOwnedRun(journal: NativeJournal, id: string): Record<string, unknown> | undefined {
  let owned: Record<string, unknown> | undefined;
  for (const record of journal.records) {
    if (record.value.type === "custom" && record.value.customType === "subagent-run") {
      const { data } = journal.body(record);
      if (isRecord(data) && data.runId === id) {
        owned = data;
      }
    }
  }
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
  const [opening] = journal.records;
  if (opening === undefined) {
    throw new Error("Not a readable native Pi session.");
  }
  const sessionId = journal.body(opening).id;
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

function publishSavedRun(base: string, launch: Launch): void {
  const dir = runDirectory(base, launch.id);
  fs.mkdirSync(dir, { mode: 0o700 });
  try {
    write(path.join(dir, "launch.json"), launch, true);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function savedOverseerFields(
  overseer: OverseerLaunch | undefined,
): Partial<Pick<Launch, "overseer">> {
  return overseer === undefined ? {} : { overseer };
}

export function savedContinuation(options: {
  id: string;
  prompt: string;
  overseer?: OverseerLaunch | undefined;
  context: ExtensionContext;
  base: string;
  agentDir: string;
}): { launch: Launch; kind: "created" | "existing" } {
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
    return { launch: launchAt(base, adopted.id, owner), kind: "existing" };
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
    ...savedOverseerFields(options.overseer),
    ...snapshot,
    createdAt: Date.now(),
  };
  publishSavedRun(base, launch);
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
    return { launch: launchAt(base, winner.id, owner), kind: "existing" };
  }
  return { launch, kind: "created" };
}
