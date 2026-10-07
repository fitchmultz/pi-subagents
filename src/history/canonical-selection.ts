import * as fs from "node:fs";
import * as path from "node:path";
import { getRunMetadataDir } from "../runs/shared/supervisor-questions.ts";
import { HistoryIndexError, type HistoryResult, type HistoryRunRow } from "./types.ts";
import type { HistoryQueries } from "./queries.ts";
import { exactTextDigest, hasText } from "./text.ts";
import { readCanonicalOutput, readSavedOutput } from "./canonical-result.ts";

function output(view: HistoryRunRow, child: HistoryRunRow["children"][number]): string {
  const result = child.result;
  if (!result) {
    return "";
  }
  if (hasText(result.fullOutputPath)) {
    return readSavedOutput(result.fullOutputPath);
  }
  const file =
    view.resultPath ?? path.join(getRunMetadataDir(view.runId), "contracts", `${child.index}.json`);
  const preview = result.finalOutput ?? "";
  return fs.existsSync(file) ? (readCanonicalOutput(file, child.index) ?? preview) : preview;
}
/** Saved full output takes precedence over canonical detail, which precedes the projected preview. */
export function selectCanonicalResult(
  view: HistoryRunRow,
  index: number,
  queries: Readonly<HistoryQueries>,
): HistoryResult | null {
  const child = view.children.find((candidate) => candidate.index === index);
  if (!child) {
    throw new HistoryIndexError("OWNERSHIP", "Child is not admitted by this owner.");
  }
  if (!child.result) {
    return null;
  }
  const body = output(view, child);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new HistoryIndexError(
      "RECORD_TOO_LARGE",
      "Selected canonical output exceeds the 16 MiB detail budget.",
    );
  }
  const boundary =
    child.state === "live"
      ? {}
      : {
          terminalEntryId: child.result.terminalEntryId,
          endedAt: hasText(child.result.terminalEntryId) ? undefined : view.updatedAt,
        };
  const finalResultId = queries.finalResultId(
    { runId: view.runId, index, ...boundary },
    exactTextDigest(body),
  );
  return { text: body, timestamp: view.updatedAt, finalResultId };
}
