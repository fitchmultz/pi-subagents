import * as fs from "node:fs";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { errorMessage } from "../shared/unknown.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as PI_SDK_VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";
import { EXTENSION_BUILD } from "./build-info.ts";
import { discoverAgentsAll, type AgentSource } from "../agents/agents.ts";
import { discoverAvailableSkills, type SkillSource } from "../agents/skills.ts";
import {
  ASYNC_DIR,
  CHAIN_RUNS_DIR,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  type ExtensionConfig,
  type SubagentState,
  type SubagentIntercomConnection,
} from "../shared/types.ts";

interface DoctorReportInput {
  cwd: string;
  nativeSessionCwd?: string;
  config: ExtensionConfig;
  state: Pick<SubagentState, "currentSessionId">;
  requestedSessionDir?: string;
  currentSessionFile?: string | null;
  currentSessionId?: string | null;
  orchestratorTarget?: string;
  connection?: SubagentIntercomConnection;
  sessionError?: string;
  expandTilde?: (value: string) => string;
  projectTrusted?: boolean;
}

const PI_SDK_RESOURCE_DIR = getPackageDir();
const EXTENSION_MODULE = fileURLToPath(import.meta.url);

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : errorMessage(error);
}

function lineFromCheck(label: string, check: () => string): string {
  try {
    return check();
  } catch (error) {
    return `- ${label}: failed — ${errorText(error)}`;
  }
}

function formatExistingDirectory(label: string, dirPath: string): string {
  try {
    if (!fs.existsSync(dirPath)) {
      return `- ${label}: missing (${dirPath})`;
    }
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`not a directory: ${dirPath}`);
    }
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return `- ${label}: ok (${dirPath})`;
  } catch (error) {
    return `- ${label}: failed (${dirPath}) — ${errorText(error)}`;
  }
}

function formatSourceCounts(counts: Readonly<Record<AgentSource, number>>): string {
  return `builtin ${counts.builtin}, package ${counts.package}, user ${counts.user}, project ${counts.project}`;
}

function formatSkillSourceCounts(skills: ReadonlyArray<{ readonly source: SkillSource }>): string {
  const counts = new Map<SkillSource, number>();
  for (const skill of skills) {
    counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
  }
  const ordered: SkillSource[] = [
    "project",
    "project-settings",
    "project-package",
    "user",
    "user-settings",
    "user-package",
    "extension",
    "builtin",
    "unknown",
  ];
  const parts = ordered
    .map((source) => `${source} ${counts.get(source) ?? 0}`)
    .filter((part) => !part.endsWith(" 0"));
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatConfiguredSessionDir(input: ReadonlyInput<DoctorReportInput>): string {
  const dir = input.requestedSessionDir ?? "";
  const configured = dir.length > 0 ? dir : (input.config.defaultSessionDir ?? "");
  if (configured.length > 0) {
    return path.resolve(input.expandTilde?.(configured) ?? configured);
  }
  return "not configured";
}

function formatSessionLines(input: ReadonlyInput<DoctorReportInput>): string[] {
  const sessionFile = input.currentSessionFile ?? null;
  const lines = [
    lineFromCheck(
      "configured session dir",
      () => `- configured session dir: ${formatConfiguredSessionDir(input)}`,
    ),
    `- current session file: ${sessionFile ?? "not available"}`,
    `- current session dir: ${sessionFile !== null && sessionFile.length > 0 ? path.dirname(sessionFile) : "not available"}`,
    `- current session id: ${input.currentSessionId ?? input.state.currentSessionId ?? "not available"}`,
  ];
  if (input.sessionError !== undefined && input.sessionError.length > 0) {
    lines.push(`- session manager: failed — ${input.sessionError}`);
  }
  return lines;
}

function formatDiscovery(input: ReadonlyInput<DoctorReportInput>): string[] {
  return [
    lineFromCheck("agents/chains", () => {
      const discovered = discoverAgentsAll(input.cwd, {
        projectTrusted: input.projectTrusted ?? true,
      });
      const agentCounts = {
        builtin: discovered.builtin.length,
        package: discovered.package.length,
        user: discovered.user.length,
        project: discovered.project.length,
      };
      const chainCounts = { builtin: 0, package: 0, user: 0, project: 0 };
      for (const chain of discovered.chains) {
        chainCounts[chain.source] += 1;
      }
      return [
        `- agents: total ${agentCounts.builtin + agentCounts.package + agentCounts.user + agentCounts.project} (${formatSourceCounts(agentCounts)})`,
        `- chains: total ${discovered.chains.length} (${formatSourceCounts(chainCounts)})`,
      ].join("\n");
    }),
    lineFromCheck("skills", () => {
      const skills = discoverAvailableSkills(input.cwd, {
        projectTrusted: input.projectTrusted ?? true,
      });
      return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
    }),
  ];
}

function connectionStatus(
  connection: Readonly<SubagentIntercomConnection> | undefined,
  reason: string,
): string {
  return `${connection?.status ?? "unknown"}${reason.length > 0 ? ` — ${reason}` : ""}`;
}

function formatIntercomSection(input: ReadonlyInput<DoctorReportInput>): string[] {
  const reason = input.connection?.reason ?? "";
  const target = input.orchestratorTarget?.trim() ?? "";
  return [
    `- bridge: ${input.connection ? "responding" : "unavailable (no live health response)"}`,
    `- connection: ${connectionStatus(input.connection, reason)}`,
    `- broker session id: ${input.connection?.sessionId ?? "not available"}`,
    `- orchestrator target: ${target.length > 0 ? target : "not available"}`,
  ];
}

function formatBuild(): string {
  const { version, sha256 } = EXTENSION_BUILD;
  return version !== undefined && sha256 !== undefined && version.length > 0 && sha256.length > 0
    ? `${version} (runtime SHA-256 ${sha256})`
    : "unknown (unbuilt source)";
}

export function buildDoctorReport(input: ReadonlyInput<DoctorReportInput>): string {
  const lines = [
    "Subagents doctor report",
    "",
    "Runtime",
    `- Native session cwd: ${input.nativeSessionCwd ?? input.cwd}`,
    ...(input.nativeSessionCwd !== undefined &&
    input.nativeSessionCwd.length > 0 &&
    input.nativeSessionCwd !== input.cwd
      ? [`- Requested cwd: ${input.cwd}`]
      : []),
    `- Node: ${process.version}`,
    `- process: ${process.pid} (${process.execPath})`,
    `- imported Pi SDK version: ${PI_SDK_VERSION} (not proof of the executing CLI version)`,
    `- Pi SDK resource directory: ${PI_SDK_RESOURCE_DIR} (may be overridden; not executable provenance)`,
    "- native queue contract: not verified (version alone does not identify fork patches)",
    `- loaded pi-subagents build: ${formatBuild()}`,
    `- extension module: ${EXTENSION_MODULE}`,
    "- async support: available (Node >=24)",
    ...formatSessionLines(input),
    "",
    "Filesystem",
    formatExistingDirectory("temp root", TEMP_ROOT_DIR),
    formatExistingDirectory("async runs", ASYNC_DIR),
    formatExistingDirectory("results", RESULTS_DIR),
    formatExistingDirectory("chain runs", CHAIN_RUNS_DIR),
    "",
    "Discovery",
    ...formatDiscovery(input),
    "",
    "Intercom",
    ...formatIntercomSection(input),
  ];
  return lines.join("\n");
}
