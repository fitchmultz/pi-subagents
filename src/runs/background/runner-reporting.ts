import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import type { ReadonlyDeep } from "type-fest";
import { findLatestSessionFile } from "../../shared/utils.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import type { SubagentRunMode } from "../../shared/types.ts";
import type { SubagentRunConfig } from "./runner-contract.ts";

export function runnerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : inspect(error);
}

function resolvePiPackageRootFallback(): string {
  const root = resolveInstalledPiPackageRoot();
  if (root !== undefined && root.length > 0) {
    return root;
  }
  throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}

export async function exportSessionHtml(
  sessionFile: string,
  outputDir: string,
  piPackageRoot?: string,
): Promise<string> {
  const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
  const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
  const moduleUrl = pathToFileURL(exportModulePath).href;
  const mod: unknown = await import(moduleUrl);
  if (
    typeof mod !== "object" ||
    mod === null ||
    !("exportFromFile" in mod) ||
    typeof mod.exportFromFile !== "function"
  ) {
    throw new Error("exportFromFile not available");
  }
  const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
  const exported: unknown = await Reflect.apply(mod.exportFromFile, mod, [
    sessionFile,
    { outputPath },
  ]);
  if (typeof exported !== "string") {
    throw new Error("exportFromFile returned an invalid output path");
  }
  return exported;
}

export function createShareLink(
  htmlPath: string,
): { shareUrl: string; gistUrl: string } | { error: string } {
  try {
    const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
    if (auth.status !== 0) {
      return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
    }
  } catch {
    return { error: "GitHub CLI (gh) is not installed." };
  }

  try {
    const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      const err = stderr.length > 0 ? stderr : "Failed to create gist.";
      return { error: err };
    }
    const gistUrl = result.stdout.trim();
    const gistId = gistUrl.split("/").pop();
    if (gistId === undefined || gistId.length === 0) {
      return { error: "Failed to parse gist ID." };
    }
    const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
    return { shareUrl, gistUrl };
  } catch (err) {
    return { error: runnerErrorMessage(err) };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function writeRunLog(
  logPath: string,
  input: ReadonlyDeep<{
    id: string;
    mode: SubagentRunMode;
    cwd: string;
    startedAt: number;
    endedAt: number;
    steps: Array<{
      agent: string;
      status: string;
      durationMs?: number;
    }>;
    summary: string;
    truncated: boolean;
    artifactsDir?: string;
    sessionFile?: string;
    shareUrl?: string;
    shareError?: string;
  }>,
): void {
  const lines: string[] = [];
  lines.push(`# Subagent run ${input.id}`);
  lines.push("");
  lines.push(`- **Mode:** ${input.mode}`);
  lines.push(`- **Launch cwd:** ${input.cwd}`);
  lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
  lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
  lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
  const references = [
    { label: "Session", value: input.sessionFile },
    { label: "Share", value: input.shareUrl },
    { label: "Share error", value: input.shareError },
    { label: "Artifacts", value: input.artifactsDir },
  ];
  for (const reference of references) {
    if (reference.value !== undefined && reference.value.length > 0) {
      lines.push(`- **${reference.label}:** ${reference.value}`);
    }
  }
  lines.push("");
  lines.push("## Steps");
  lines.push("| Step | Agent | Status | Duration |");
  lines.push("| --- | --- | --- | --- |");
  input.steps.forEach((step, i) => {
    const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
    lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
  });
  lines.push("");
  lines.push("## Summary");
  if (input.truncated) {
    lines.push("_Output truncated_");
    lines.push("");
  }
  const summary = input.summary.trim();
  lines.push(summary.length > 0 ? summary : "(no output)");
  lines.push("");
  fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}

interface SessionShare {
  readonly sessionFile?: string;
  readonly shareUrl?: string;
  readonly gistUrl?: string;
  readonly shareError?: string;
}

export async function shareRunnerSession(
  config: ReadonlyDeep<SubagentRunConfig>,
  latestSessionFile: string | undefined,
): Promise<SessionShare> {
  if (config.share !== true) {
    return { sessionFile: latestSessionFile };
  }
  const discovered =
    config.sessionDir === undefined || config.sessionDir.length === 0
      ? undefined
      : findLatestSessionFile(config.sessionDir);
  const sessionFile = discovered ?? latestSessionFile;
  if (sessionFile === undefined || sessionFile.length === 0) {
    return { sessionFile: latestSessionFile, shareError: "Session file not found." };
  }
  try {
    const exportDir = config.sessionDir ?? path.dirname(sessionFile);
    fs.mkdirSync(exportDir, { recursive: true });
    const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
    const share = createShareLink(htmlPath);
    if ("error" in share) {
      return { sessionFile, shareError: share.error };
    }
    return { sessionFile, ...share };
  } catch (error) {
    return { sessionFile, shareError: runnerErrorMessage(error) };
  }
}
