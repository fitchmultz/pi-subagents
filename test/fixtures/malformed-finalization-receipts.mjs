import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createFinalizationReportRuntime,
  readFinalizationReport,
} from "../../src/runs/shared/acceptance-finalization.ts";

// These are malformed external receipt values, not negative compiler assertions.
const flags = [
  { name: "missing", value: undefined },
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "zero", value: 0 },
  { name: "empty string", value: "" },
  { name: "true", value: true },
];
const value = {
  answer: "Current independently verified answer",
  report: { diffSummary: "Current verified report" },
};
const assistant = fauxAssistantMessage(
  fauxToolCall("structured_output", { value }, { id: "current" }),
  { stopReason: "toolUse" },
);
const receipt = {
  role: "toolResult",
  toolCallId: "current",
  toolName: "structured_output",
  content: [{ type: "text", text: "Captured" }],
  timestamp: Date.now(),
  isError: false,
};
const malformed = flags.map(({ name, value: flag }) => {
  const result = { ...receipt, isError: flag };
  if (name === "missing") {
    delete result.isError;
  }
  return { name, result };
});
const runtime = createFinalizationReportRuntime();
try {
  writeFileSync(runtime.outputPath, JSON.stringify(value));
  const accepted = readFinalizationReport([assistant, receipt], runtime);
  assert.equal(accepted.output, value.answer);
  assert.deepEqual(accepted.report, value.report);
  assert.equal(accepted.reportSubmissionError, undefined);

  const publication = malformed.map(({ name, result }) => {
    const submission = readFinalizationReport([assistant, result], runtime);
    return {
      name,
      reportRejected: submission.report === undefined,
      receiptRejected: /no matching successful result/.test(submission.reportSubmissionError ?? ""),
    };
  });
  // With no capture, only a genuinely successful receipt may retain the call's audit evidence.
  rmSync(runtime.outputPath);
  assert.equal(existsSync(runtime.outputPath), false);
  const audit = readFinalizationReport([assistant, receipt], runtime);
  assert.match(audit.reportSubmissionError ?? "", /Missing structured_output/);
  assert.match(audit.unconfirmedOutput ?? "", /Current independently verified answer/);
  const retained = malformed.map(({ name, result }) => ({
    name,
    auditRejected:
      readFinalizationReport([assistant, result], runtime).unconfirmedOutput === undefined,
  }));
  assert.deepEqual(
    { publication, retained },
    {
      publication: flags.map(({ name }) => ({ name, reportRejected: true, receiptRejected: true })),
      retained: flags.map(({ name }) => ({ name, auditRejected: true })),
    },
  );
} finally {
  rmSync(dirname(runtime.schemaPath), { recursive: true, force: true });
}
