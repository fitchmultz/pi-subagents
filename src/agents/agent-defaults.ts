import type { SystemPromptMode } from "../shared/types/config.ts";

export function defaultSystemPromptMode(_name: string): SystemPromptMode {
  return "append";
}

export function defaultInheritProjectContext(_name: string): boolean {
  return true;
}

export function defaultInheritSkills(): boolean {
  return true;
}
