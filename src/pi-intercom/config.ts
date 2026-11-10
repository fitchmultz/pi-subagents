import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir } from "./agent-dir.ts";
import { isRecord, isUnknownArray } from "./validation.ts";
import { errorMessage } from "../shared/unknown.ts";

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (for example, Node or Bun). */
  readonly brokerCommand: string;
  /** Arguments passed to the broker command before the broker script path. */
  readonly brokerArgs: readonly string[];
  /** Require confirmation before non-reply sends from interactive sessions. */
  readonly confirmSend: boolean;
  /** Optional custom status suffix shown after automatic lifecycle status. */
  readonly status?: string | undefined;
  /** Show reply hint in incoming messages (default: true). */
  readonly replyHint: boolean;
  /** Ordinary ask reply timeout, in milliseconds (default: 120000 = 2 minutes). */
  readonly askTimeoutMs: number;
  /** Broker delivery acknowledgement timeout, in milliseconds (default: 8000). */
  readonly sendTimeoutMs: number;
  /** Session list response timeout, in milliseconds (default: 5000). */
  readonly listTimeoutMs: number;
  /** This device's SSH alias, as the owner's other devices know it. */
  readonly device?: string | undefined;
  /** SSH aliases of the owner's other devices. Unset: no other device is reachable. */
  readonly otherDevices: readonly string[];
}
const defaults: IntercomConfig = {
  brokerCommand: process.execPath,
  brokerArgs: [],
  confirmSend: false,
  replyHint: true,
  askTimeoutMs: 2 * 60 * 1000,
  sendTimeoutMs: 8000,
  listTimeoutMs: 5000,
  otherDevices: [],
};
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
/** A device name goes to `ssh` as the destination: it must not read as an option or a path. */
export function isDeviceAlias(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}
function configuredDevice(parsed: Readonly<Record<string, unknown>>): string | undefined {
  if (!Object.hasOwn(parsed, "device")) {
    return defaults.device;
  }
  if (!isDeviceAlias(parsed.device)) {
    throw new Error('"device" must be an SSH alias of letters, digits, ".", "_" and "-"');
  }
  return parsed.device;
}
function configuredOtherDevices(
  parsed: Readonly<Record<string, unknown>>,
  self: string | undefined,
): readonly string[] {
  if (!Object.hasOwn(parsed, "otherDevices")) {
    return defaults.otherDevices;
  }
  const { otherDevices } = parsed;
  if (!isUnknownArray(otherDevices) || !otherDevices.every(isDeviceAlias)) {
    throw new Error(
      '"otherDevices" must be an array of SSH aliases of letters, digits, ".", "_" and "-"',
    );
  }
  // One list can be shared by every device: a device skips its own alias.
  return otherDevices.filter((alias) => alias !== self);
}
export function intercomConfigPath(): string {
  return join(getPiAgentDir(), "intercom", "config.json");
}
export function loadConfig(report: (message: string) => void = console.error): IntercomConfig {
  const configPath = intercomConfigPath();
  if (!existsSync(configPath)) {
    return { ...defaults };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    const device = configuredDevice(parsed);
    return {
      brokerCommand: brokerCommand(parsed),
      brokerArgs: configuredArgs(parsed),
      confirmSend: configuredBoolean(parsed, "confirmSend"),
      replyHint: configuredBoolean(parsed, "replyHint"),
      status: configuredString(parsed, "status"),
      askTimeoutMs: configuredTimeout(parsed, "askTimeoutMs"),
      sendTimeoutMs: configuredTimeout(parsed, "sendTimeoutMs"),
      listTimeoutMs: configuredTimeout(parsed, "listTimeoutMs"),
      device,
      otherDevices: configuredOtherDevices(parsed, device),
    };
  } catch (error) {
    report(
      `Failed to load intercom config at ${configPath}: ${errorMessage(error)}. Using defaults.`,
    );
    return { ...defaults };
  }
}
