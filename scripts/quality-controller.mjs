#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./compat-process.mjs";

const directory = fileURLToPath(new URL("./protected-macos-controller/", import.meta.url));

async function formatting(write) {
  const output = await run("gofmt", [write ? "-w" : "-l", directory]);
  if (!write && output.trim() !== "") {
    throw new Error(`Go formatting differs; run npm run format:controller:\n${output}`);
  }
}

async function checkController() {
  await run("go", ["vet", "-mod=readonly", "./..."], { cwd: directory, stdio: "inherit" });
  await run("go", ["mod", "verify"], { cwd: directory, stdio: "inherit" });
  await run("go", ["test", "-mod=readonly", "-race", "-count=1", "-timeout=600s", "./..."], {
    cwd: directory,
    stdio: "inherit",
    // The command owner must outlive Go's own test deadline and startup.
    timeout: 660_000,
  });
  const temporary = mkdtempSync(join(tmpdir(), "pi-controller-check-"));
  const executable = join(temporary, "protected-macos-controller");
  let cleanupSafe = true;
  try {
    await run("go", ["build", "-mod=readonly", "-trimpath", "-o", executable, "."], {
      cwd: directory,
      stdio: "inherit",
    });
    await run(executable, ["--help"], { stdio: "inherit" });
  } catch (error) {
    cleanupSafe = error.cleanupFailed !== true;
    throw error;
  } finally {
    if (cleanupSafe) {
      rmSync(temporary, { recursive: true });
    } else {
      console.error(`Uncertain controller-check descendants; retaining ${temporary}`);
    }
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/quality-controller.mjs [--format|--format-check]\nCheck the auxiliary Go controller with vet, module verification, race tests, build and actual CLI help.\n--format writes native gofmt formatting; --format-check rejects formatting drift only.\nUses the committed Go module; never activates services, accesses credentials or provisions runners.\nGo is required for development/CI, not normal extension install/build.\nExit 1 on a failed command or uncertain process cleanup. Example: npm run quality:controller",
  );
} else if (args.length === 0) {
  await checkController();
} else if (args.length === 1 && ["--format", "--format-check"].includes(args[0])) {
  await formatting(args[0] === "--format");
} else {
  throw new Error("Unknown controller-check option; use --help");
}
