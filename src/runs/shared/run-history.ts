import * as fs from "node:fs";
import * as path from "node:path";
import {
  historyDirectory,
  historyTransaction,
  openHistoryDatabase,
} from "../../history/database.ts";
import { getAgentDir } from "../../shared/utils.ts";

export interface RunEntry {
  agent: string;
  task: string;
  ts: number;
  status: "ok" | "error";
  duration: number;
  exit?: number;
}

const MAX_AGENT_SAMPLES = 1000;
const MAX_LEGACY_BYTES = 1024 * 1024;
const TIMING_DATABASE = "run-timing.sqlite";

function validEntry(value: unknown): value is RunEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as RunEntry;
  return (
    typeof entry.agent === "string" &&
    entry.agent.length > 0 &&
    entry.agent.length <= 256 &&
    typeof entry.task === "string" &&
    Number.isSafeInteger(entry.ts) &&
    entry.ts >= 0 &&
    (entry.status === "ok" || entry.status === "error") &&
    Number.isFinite(entry.duration) &&
    entry.duration >= 0 &&
    (entry.exit === undefined || Number.isSafeInteger(entry.exit))
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
      if (!read) {
        break;
      }
      count += read;
    }
    const complete = bytes.subarray(0, count),
      first = start ? complete.indexOf(10) + 1 : 0,
      last = complete.lastIndexOf(10);
    if (last < first || (start && !first)) {
      return [];
    }
    const samples: RunEntry[] = [],
      retained = new Map<string, number>();
    for (const line of complete.subarray(first, last).toString("utf8").split("\n").reverse()) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          !validEntry(entry) ||
          (agent !== undefined && entry.agent !== agent) ||
          (retained.get(entry.agent) ?? 0) >= MAX_AGENT_SAMPLES
        ) {
          continue;
        }
        samples.push({ ...entry, task: entry.task.slice(0, 200) });
        retained.set(entry.agent, (retained.get(entry.agent) ?? 0) + 1);
        if (agent !== undefined && samples.length === MAX_AGENT_SAMPLES) {
          break;
        }
      } catch {
        /* Incomplete or invalid timing samples are not evidence. */
      }
    }
    return samples;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
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
  if (!validEntry(entry)) {
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
      .map((row) => ({
        agent: String(row.agent),
        task: String(row.task),
        ts: Number(row.ts),
        status: row.status as RunEntry["status"],
        duration: Number(row.duration),
        ...(row.exit === null ? {} : { exit: Number(row.exit) }),
      }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
