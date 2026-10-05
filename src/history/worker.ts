import { HistoryIndexError, type Request, type Response } from "./types.ts";
import { HistoryWorker } from "./worker-runtime.ts";
import {
  parseRequest,
  parseOwner,
  parseRunOptions,
  parsePageInput,
  parseSearchInput,
  parseEntryInput,
  parseRefresh,
} from "./wire-inputs.ts";
import { parseForegroundResumeRun, parseOwnedRun } from "../runs/background/run-schemas.ts";
import { object } from "./values.ts";

const agentDir = process.argv.at(2);
if (agentDir === undefined || agentDir.length === 0) {
  throw new HistoryIndexError("INVALID", "History worker requires an agent directory.");
}
process.umask(0o077);
function send(response: Response): void {
  if (process.connected && process.send !== undefined) {
    process.send(response);
  }
}
const worker = new HistoryWorker(agentDir, send);
function query(request: Request): unknown {
  const queries = worker.requireQueries();
  switch (request.method) {
    case "status":
      return worker.status();
    case "listRuns":
      worker.countQuery();
      return queries.listRuns(parseRunOptions(request.input));
    case "historyPage":
      worker.countQuery();
      return queries.historyPage(parsePageInput(request.input));
    case "search":
      worker.countQuery();
      return queries.search(parseSearchInput(request.input));
    case "result":
      return worker.result(parseEntryInput(request.input));
    case "entry":
      return queries.selected(parseEntryInput(request.input), false);
    case "record":
      return queries.selected(parseEntryInput(request.input), true);
    default:
      throw new HistoryIndexError("INVALID", "Unknown history operation.");
  }
}
function handle(request: Request): void {
  try {
    switch (request.method) {
      case "setOwner":
        worker.setOwner(parseOwner(request.input, parseForegroundResumeRun));
        send({ id: request.id });
        break;
      case "updateRun": {
        const input = object(request.input);
        const run = parseOwnedRun(input.run);
        const foreground =
          input.foreground === undefined ? undefined : parseForegroundResumeRun(input.foreground);
        if (foreground && foreground.runId !== run.runId) {
          throw new HistoryIndexError("OWNERSHIP", "Foreground snapshot is not this owned run.");
        }
        worker.updateRun(run, foreground);
        send({ id: request.id });
        break;
      }
      case "refresh":
        worker.refresh(request.id, parseRefresh(request.input));
        break;
      case "needsControls":
        worker.needsControls(request.id);
        break;
      default:
        send({ id: request.id, value: query(request) });
    }
  } catch (error) {
    worker.errorReply(request.id, error);
  }
}
process.on("message", (value: unknown) => {
  try {
    handle(parseRequest(value));
  } catch {
    // Invalid envelopes have no trustworthy request ID. Drop them without logging private payloads.
  }
});
process.on("disconnect", () => {
  worker.close();
  process.exit(0);
});
