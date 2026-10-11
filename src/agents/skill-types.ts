/** Caller-owned skill metadata shared by discovery and content resolution. */
export type SkillSource =
  | "project"
  | "user"
  | "project-package"
  | "user-package"
  | "project-settings"
  | "user-settings"
  | "extension"
  | "builtin"
  | "unknown";
export interface ResolvedSkill {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly source: SkillSource;
}
export interface CachedSkillEntry {
  readonly name: string;
  readonly filePath: string;
  readonly source: SkillSource;
  readonly description?: string;
  readonly order: number;
}
export interface SkillSearchPath {
  readonly path: string;
  readonly source: SkillSource;
}
export interface SkillDiscoveryOptions {
  readonly projectTrusted?: boolean;
}
