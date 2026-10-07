import { parseAsyncResult } from "../../src/runs/background/run-schemas.ts";
import type { AsyncResultChild } from "../../src/shared/types.ts";
import { assertDefined, readJson } from "./assertions.ts";

export {
  readResult as readRunResult,
  readStatusFile as readRunStatus,
} from "./background-fixtures.ts";

export function readChildMetadata(file: string): AsyncResultChild {
  // Artifacts publish the same child-result fields as the canonical result file.
  const envelope = parseAsyncResult({ results: [readJson(file)] });
  const result = envelope.results?.[0];
  assertDefined(result);
  return result;
}
