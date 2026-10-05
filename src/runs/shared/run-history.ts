import * as fs from "node:fs";
import * as path from "node:path";
import {
  historyDirectory,
  historyTransaction,
  openHistoryDatabase,
} from "../../history/database.ts";
import { isRecord } from "../../shared/unknown.ts";
import { getAgentDir } from "../../shared/agent-dir.ts";

export interface RunEntry {
  readonly agent: string;
  readonly task: string;
  readonly ts: number;
  readonly status: "ok" | "error";
  readonly duration: number;
  readonly exit?: number;
}

const MAX_AGENT_SAMPLES = 1000;
const MAX_LEGACY_BYTES = 1024 * 1024;
const TIMING_DATABASE = "run-timing.sqlite";

function validIdentity(entry: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof entry.agent === "string" &&
    entry.agent.length > 0 &&
    entry.agent.length <= 256 &&
    typeof entry.task === "string"
  );
}

function validTiming(entry: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof entry.ts === "number" &&
    Number.isSafeInteger(entry.ts) &&
    entry.ts >= 0 &&
    typeof entry.duration === "number" &&
    Number.isFinite(entry.duration) &&
    entry.duration >= 0
  );
}

function validEntry(value: unknown): value is RunEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    validIdentity(value) &&
    validTiming(value) &&
    (value.status === "ok" || value.status === "error") &&
    (value.exit === undefined ||
      (typeof value.exit === "number" && Number.isSafeInteger(value.exit)))
  );
}

/** Legacy samples are read-only, complete LF records from a bounded tail. */
function legacySamples(agentDir: string, agent?: string): RunEntry[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(agentDir, "run-history.jsonl"), "r");
    const size = fs.fstatSync(fd).size,
      start = Math.max(0, size - MAX_LEGACY_BYTES);
    const bytes = Buffer.alloc(size - start);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, start + count);
      if (read === 0) {
        break;
      }
      count += read;
    }
    const complete = bytes.subarray(0, count),
      first = start > 0 ? complete.indexOf(10) + 1 : 0,
      last = complete.lastIndexOf(10);
    if (last < first || (start > 0 && first === 0)) {
      return [];
    }
    return parseLegacyLines(
      complete.subarray(first, last).toString("utf8").split("\n").reverse(),
      agent,
    );
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function parseLegacySample(line: string, agent: string | undefined): RunEntry | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    if (!validEntry(entry) || (agent !== undefined && entry.agent !== agent)) {
      return;
    }
    return entry;
  } catch {
    // Invalid timing samples are not evidence; valid neighboring LF records survive.
    return;
  }
}

function parseLegacyLines(lines: readonly string[], agent: string | undefined): RunEntry[] {
  const samples: RunEntry[] = [];
  const retained = new Map<string, number>();
  for (const line of lines) {
    const entry = parseLegacySample(line, agent);
    if (!entry || (retained.get(entry.agent) ?? 0) >= MAX_AGENT_SAMPLES) {
      continue;
    }
    samples.push({ ...entry, task: entry.task.slice(0, 200) });
    retained.set(entry.agent, (retained.get(entry.agent) ?? 0) + 1);
    if (agent !== undefined && samples.length === MAX_AGENT_SAMPLES) {
      break;
    }
  }
  return samples;
}

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
  const entry: RunEntry = {
    agent,
    task: task.slice(0, 200),
    ts: Math.floor(Date.now() / 1000),
    status: exitCode === 0 ? "ok" : "error",
    duration: durationMs,
    ...(exitCode !== 0 ? { exit: exitCode } : {}),
  };
  if (
    !validIdentity({ ...entry }) ||
    !validTiming({ ...entry }) ||
    !Number.isSafeInteger(exitCode)
  ) {
    return;
  }
  let db: ReturnType<typeof openHistoryDatabase> | undefined;
  try {
    const agentDir = getAgentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    db = openHistoryDatabase(path.join(historyDirectory(agentDir), TIMING_DATABASE));
    const connection = db;
    historyTransaction(connection, () => {
      connection.exec(`CREATE TABLE IF NOT EXISTS timing_meta(key TEXT PRIMARY KEY);
				CREATE TABLE IF NOT EXISTS samples(sequence INTEGER PRIMARY KEY,agent TEXT NOT NULL,task TEXT NOT NULL,ts INTEGER NOT NULL,status TEXT NOT NULL,duration REAL NOT NULL,exit INTEGER);
				CREATE INDEX IF NOT EXISTS samples_agent ON samples(agent,sequence DESC);`);
      const insert = connection.prepare(
        "INSERT INTO samples(agent,task,ts,status,duration,exit) VALUES (?,?,?,?,?,?)",
      );
      const save = (sample: RunEntry) =>
        insert.run(
          sample.agent,
          sample.task,
          sample.ts,
          sample.status,
          sample.duration,
          sample.exit ?? null,
        );
      if (!connection.prepare("SELECT key FROM timing_meta WHERE key='legacy-imported'").get()) {
        for (const sample of legacySamples(agentDir).reverse()) {
          save(sample);
        }
        connection.exec("INSERT INTO timing_meta VALUES ('legacy-imported')");
      }
      save(entry);
      connection
        .prepare(
          "DELETE FROM samples WHERE agent=? AND sequence NOT IN (SELECT sequence FROM samples WHERE agent=? ORDER BY sequence DESC LIMIT ?)",
        )
        .run(agent, agent, MAX_AGENT_SAMPLES);
    });
  } catch {
    /* Best-effort timing metadata must never interrupt a run. */
  } finally {
    db?.close();
  }
}

export function loadRunsForAgent(agent: string): RunEntry[] {
  const agentDir = getAgentDir(),
    file = path.join(agentDir, "history-index", TIMING_DATABASE);
  if (!fs.existsSync(file)) {
    return legacySamples(agentDir, agent);
  }
  let db: ReturnType<typeof openHistoryDatabase> | undefined;
  try {
    db = openHistoryDatabase(path.join(historyDirectory(agentDir, false), TIMING_DATABASE), true);
    return db
      .prepare(
        "SELECT agent,task,ts,status,duration,exit FROM samples WHERE agent=? ORDER BY sequence DESC LIMIT ?",
      )
      .all(agent, MAX_AGENT_SAMPLES)
      .flatMap((row) => {
        const entry = {
          agent: row.agent,
          task: row.task,
          ts: row.ts,
          status: row.status,
          duration: row.duration,
          ...(row.exit === null ? {} : { exit: row.exit }),
        };
        return validEntry(entry) ? [entry] : [];
      });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
