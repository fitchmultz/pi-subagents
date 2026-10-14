#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readBridgeFile, writeBridgeJson } from "../src/pi-intercom/bridge-files.ts";
import { stateDirectory } from "../src/pi-intercom/bridge-storage.ts";
import { isRecord } from "../src/shared/unknown.ts";

// Run only after proving this history covers every legacy worker and stopping those workers.
// --complete-since is the operator's coverage attestation, not something outcomes can prove.
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    audit: { type: "string" },
    "complete-since": { type: "string" },
    "stopped-at": { type: "string" },
    "stopped-pid": { type: "string" },
    "unknown-attempts": { type: "string" },
  },
});
try {
  const stateDir = stateDirectory(values["state-dir"]);
  const coveredSince = Date.parse(values["complete-since"] ?? "");
  const stoppedAt = Date.parse(values["stopped-at"] ?? "");
  const pid = Number(values["stopped-pid"]);
  const unknownAttempts = Number(values["unknown-attempts"]);
  if (
    stateDir === undefined ||
    values.audit === undefined ||
    !Number.isSafeInteger(coveredSince) ||
    !Number.isSafeInteger(stoppedAt) ||
    coveredSince > stoppedAt - 3600000 ||
    stoppedAt > Date.now() ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    values["unknown-attempts"] === undefined ||
    !Number.isInteger(unknownAttempts) ||
    unknownAttempts < 0 ||
    unknownAttempts > 20
  ) {
    throw new Error(
      "Require state-dir, private audit, complete-since (at least one hour before stopped-at), stopped-at, stopped-pid and unknown-attempts (0..20).",
    );
  }
  try {
    process.kill(pid, 0);
    throw new Error("Legacy helper is still running; stop it before preflight.");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  if (
    existsSync(join(stateDir, "wake-quota.sqlite")) ||
    existsSync(join(stateDir, "wake-history.json"))
  ) {
    throw new Error("Preflight cannot replace an existing ledger/history. Preserve it.");
  }
  const attempts = [];
  const outcomes = new Set(["accepted", "http_rejected", "transport_unconfirmed"]);
  const audit = readBridgeFile(values.audit, true, 32 * 1024 * 1024).toString("utf8");
  for (const line of audit.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    /** @type {unknown} */
    const raw = JSON.parse(line);
    if (!isRecord(raw) || typeof raw.timestamp !== "string") {
      throw new Error("Invalid audit record.");
    }
    const entry = raw;
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isSafeInteger(timestamp)) {
      throw new Error("Audit record has no valid timestamp.");
    }
    if (timestamp < coveredSince || timestamp > stoppedAt) {
      continue;
    }
    if (entry.event === "log_overflow") {
      throw new Error(
        "Audit overflow prevents complete-history migration; use conservative startup.",
      );
    }
    if (
      entry.event === "wake_delivery" &&
      typeof entry.result === "string" &&
      outcomes.has(entry.result)
    ) {
      attempts.push(timestamp);
    }
  }
  if (attempts.length > 10000) {
    throw new Error("Attempt history exceeds bounded migration input.");
  }
  writeBridgeJson(join(stateDir, "wake-history.json"), {
    coveredSince,
    stoppedAt,
    attempts,
    unknownAttempts,
  });
  console.log(
    JSON.stringify({
      result: "prepared",
      recordedAttempts: attempts.length,
      unknownAttempts,
      note: "Start the new helper against this same stateDir; never copy/reset its ledger. Coverage and unknown-attempt bounds remain operator-owned proof.",
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
