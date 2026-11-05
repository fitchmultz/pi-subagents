import { spawnSync } from "node:child_process";

export function run(command: string, args: readonly string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}
