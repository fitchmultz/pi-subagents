import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./process.ts";

export function compilerFiles(
  root: string,
  files: readonly string[],
  mode: "declarations" | "dependencies",
): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-compiler-"));
  try {
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: {
          ...(mode === "declarations" ? { skipLibCheck: false } : {}),
          noCheck: false,
          noEmit: true,
          typeRoots: [join(root, "node_modules/@types")],
        },
        files: files.map((file) => resolve(root, file)),
        include: [],
        exclude: [],
      }),
    );
    return run(
      process.execPath,
      [
        "scripts/typescript.mjs",
        "--project",
        config,
        ...(mode === "dependencies" ? ["--listFilesOnly"] : []),
      ],
      root,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
