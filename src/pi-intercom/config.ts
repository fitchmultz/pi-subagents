import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Key, type KeyId } from "@earendil-works/pi-tui";
import { getPiAgentDir } from "./agent-dir.ts";
import { isRecord, isUnknownArray } from "./validation.ts";

export interface IntercomConfig {
  /** Toggle owned agents, or open peer messaging when the agent view is unavailable. */
  readonly shortcut: KeyId;
  /** Broker command used to spawn the broker process (for example, Node or Bun). */
  readonly brokerCommand: string;
  /** Arguments passed to the broker command before the broker script path. */
  readonly brokerArgs: readonly string[];
  /** Require confirmation before non-reply sends from interactive sessions. */
  readonly confirmSend: boolean;
  /** Optional custom status suffix shown after automatic lifecycle status. */
  readonly status?: string;
  /** Show reply hint in incoming messages (default: true). */
  readonly replyHint: boolean;
  /** Ordinary ask reply timeout, in milliseconds (default: 120000 = 2 minutes). */
  readonly askTimeoutMs: number;
  /** Broker delivery acknowledgement timeout, in milliseconds (default: 8000). */
  readonly sendTimeoutMs: number;
  /** Session list response timeout, in milliseconds (default: 5000). */
  readonly listTimeoutMs: number;
}
const defaults: IntercomConfig = {
  shortcut: Key.altShift("m"),
  brokerCommand: process.execPath,
  brokerArgs: [],
  confirmSend: false,
  replyHint: true,
  askTimeoutMs: 2 * 60 * 1000,
  sendTimeoutMs: 8000,
  listTimeoutMs: 5000,
};
const namedKeys = new Set<string>(Object.values(Key).filter((key) => typeof key === "string"));
function isShortcut(value: string): value is KeyId {
  const prefix = value.match(/^(?:(?:ctrl|shift|alt|super)\+)+/)?.[0] ?? "";
  const modifiers = prefix.split("+").filter(Boolean);
  const key = value.slice(prefix.length);
  return (
    new Set(modifiers).size === modifiers.length && (namedKeys.has(key) || /^[a-z0-9]$/.test(key))
  );
}
function configuredString(
  parsed: Readonly<Record<string, unknown>>,
  key: "brokerCommand" | "status",
): string | undefined {
  if (!Object.hasOwn(parsed, key)) {
    return defaults[key];
  }
  const value = parsed[key];
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  if (key === "status") {
    return value;
  }
  if (value.trim() === "") {
    throw new Error('"brokerCommand" must not be empty');
  }
  return value.trim();
}
function brokerCommand(parsed: Readonly<Record<string, unknown>>): string {
  return configuredString(parsed, "brokerCommand") ?? defaults.brokerCommand;
}
function configuredShortcut(parsed: Readonly<Record<string, unknown>>): KeyId {
  if (!Object.hasOwn(parsed, "shortcut")) {
    return defaults.shortcut;
  }
  if (typeof parsed.shortcut !== "string") {
    throw new Error('"shortcut" must be a native key identifier');
  }
  const shortcut = parsed.shortcut.trim();
  if (!isShortcut(shortcut)) {
    throw new Error('"shortcut" must be a native key identifier, for example alt+shift+m');
  }
  return shortcut;
}
function configuredArgs(parsed: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Object.hasOwn(parsed, "brokerArgs")) {
    return defaults.brokerArgs;
  }
  if (!isUnknownArray(parsed.brokerArgs)) {
    throw new Error('"brokerArgs" must be an array');
  }
  return parsed.brokerArgs.map((arg) => {
    if (typeof arg !== "string") {
      throw new Error('"brokerArgs" items must be strings');
    }
    return arg;
  });
}
function configuredBoolean(
  parsed: Readonly<Record<string, unknown>>,
  key: "confirmSend" | "replyHint",
): boolean {
  if (!Object.hasOwn(parsed, key)) {
    return defaults[key];
  }
  const value = parsed[key];
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}
function configuredTimeout(
  parsed: Readonly<Record<string, unknown>>,
  key: "askTimeoutMs" | "sendTimeoutMs" | "listTimeoutMs",
): number {
  if (!Object.hasOwn(parsed, key)) {
    return defaults[key];
  }
  const value = parsed[key];
  const min = key === "askTimeoutMs" ? 1000 : 500;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`"${key}" must be a finite number >= ${min}`);
  }
  return value;
}
export function loadConfig(): IntercomConfig {
  const configPath = join(getPiAgentDir(), "intercom", "config.json");
  if (!existsSync(configPath)) {
    return { ...defaults };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    return {
      shortcut: configuredShortcut(parsed),
      brokerCommand: brokerCommand(parsed),
      brokerArgs: configuredArgs(parsed),
      confirmSend: configuredBoolean(parsed, "confirmSend"),
      replyHint: configuredBoolean(parsed, "replyHint"),
      status: configuredString(parsed, "status"),
      askTimeoutMs: configuredTimeout(parsed, "askTimeoutMs"),
      sendTimeoutMs: configuredTimeout(parsed, "sendTimeoutMs"),
      listTimeoutMs: configuredTimeout(parsed, "listTimeoutMs"),
    };
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}
