import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Key, type KeyId } from "@earendil-works/pi-tui";
import { getPiAgentDir } from "./agent-dir.ts";

export interface IntercomConfig {
  /** Toggle owned agents, or open peer messaging when the agent view is unavailable. */
  shortcut: KeyId;

  /** Broker command used to spawn the broker process (for example, Node or Bun) */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;

  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** How long ordinary intercom `ask` waits for a reply before giving up, in ms (default: 120000 = 2 minutes). */
  askTimeoutMs: number;

  /** How long the client waits for the broker to acknowledge message delivery, in ms (default: 8000). */
  sendTimeoutMs: number;

  /** How long the client waits for a session list response, in ms (default: 5000). */
  listTimeoutMs: number;
}

function getConfigPath(): string {
  return join(getPiAgentDir(), "intercom", "config.json");
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
  return new Set(modifiers).size === modifiers.length && (namedKeys.has(key) || /^[a-z0-9]$/.test(key));
}

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...defaults };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = { ...defaults };

    if (Object.hasOwn(parsedConfig, "shortcut")) {
      if (typeof parsedConfig.shortcut !== "string") throw new Error('"shortcut" must be a native key identifier');
      const shortcut = parsedConfig.shortcut.trim();
      if (!isShortcut(shortcut)) throw new Error('"shortcut" must be a native key identifier, for example alt+shift+m');
      config.shortcut = shortcut;
    }

    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }

    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs: string[] = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    for (const [key, min] of [["askTimeoutMs", 1000], ["sendTimeoutMs", 500], ["listTimeoutMs", 500]] as const) {
      if (Object.hasOwn(parsedConfig, key)) {
        const value = parsedConfig[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
          throw new Error(`"${key}" must be a finite number >= ${min}`);
        }
        config[key] = value;
      }
    }

    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}
