import * as fs from "node:fs";
import * as path from "node:path";
import type { ReadonlyInput } from "../../shared/types.ts";
import { getRunMetadataDir, QUESTIONS_DIR } from "./run-metadata-paths.ts";

interface OwnerOutput {
  readonly finalOutput?: string;
  readonly output?: string;
  readonly initialOutput?: string;
  readonly initialOutputPath?: string;
  readonly messages?: unknown;
  readonly artifactPaths?: { readonly outputPath?: string };
  readonly fullOutputPath?: string;
}
interface OutputSlot {
  readonly runId: string;
  readonly index: number;
  readonly root: string;
}

function writeOwnedOutput(slot: OutputSlot, text: string, initial: boolean): string {
  const name = initial ? `${slot.index}.initial.txt` : `${slot.index}.txt`;
  const file = path.join(getRunMetadataDir(slot.runId, slot.root), "outputs", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function terminalOutputPath(result: OwnerOutput, slot: OutputSlot): string | undefined {
  const output = result.finalOutput ?? result.output;
  let file = result.fullOutputPath;
  if (output === undefined || output.length <= 8192) {
    return file;
  }
  file ??= result.artifactPaths?.outputPath;
  return file === undefined || file === "" ? writeOwnedOutput(slot, output, false) : file;
}
function initialOutputPath(result: OwnerOutput, slot: OutputSlot): string | undefined {
  const output = result.initialOutput;
  const file = result.initialOutputPath;
  if (output === undefined || output.length <= 8192) {
    return file;
  }
  return file === undefined || file === "" ? writeOwnedOutput(slot, output, true) : file;
}

export function compactOwnerResult<T extends OwnerOutput>(
  runId: string,
  index: number,
  result: ReadonlyInput<T>,
  root?: string,
): ReadonlyInput<T>;
export function compactOwnerResult(
  runId: string,
  index: number,
  result: OwnerOutput,
  root = QUESTIONS_DIR,
): OwnerOutput {
  const slot = { runId, index, root };
  const fullOutputPath = terminalOutputPath(result, slot);
  const initialPath = initialOutputPath(result, slot);
  return {
    ...result,
    messages: undefined,
    ...((fullOutputPath ?? "") !== "" ? { fullOutputPath } : {}),
    ...((initialPath ?? "") !== "" ? { initialOutputPath: initialPath } : {}),
    ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput.slice(-8192) } : {}),
    ...(result.output !== undefined ? { output: result.output.slice(-8192) } : {}),
    ...(result.initialOutput !== undefined
      ? { initialOutput: result.initialOutput.slice(-8192) }
      : {}),
  };
}
