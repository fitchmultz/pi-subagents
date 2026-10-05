import type { AgentConfig, ModelInfo } from "../../shared/types/config.ts";
import type { ResolvedStepBehavior } from "../../shared/types/workflow.ts";
export interface BehaviorOverride {
  readonly output?: string | false;
  readonly reads?: readonly string[] | false;
  readonly progress?: boolean;
  readonly model?: string;
  readonly skills?: readonly string[] | false;
}
export interface ChainClarifyResult {
  readonly confirmed: boolean;
  readonly templates: readonly string[];
  readonly behaviorOverrides: readonly (BehaviorOverride | undefined)[];
  readonly runInBackground?: boolean;
}
export type ClarifyMode = "single" | "parallel" | "chain";
export type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";
interface SkillChoice {
  readonly name: string;
  readonly source: string;
  readonly description?: string;
}
export interface ChainClarifyOptions {
  readonly agentConfigs: readonly AgentConfig[];
  readonly templates: readonly string[];
  readonly originalTask: string;
  readonly chainDir?: string;
  readonly resolvedBehaviors: readonly ResolvedStepBehavior[];
  readonly availableModels: readonly ModelInfo[];
  readonly preferredProvider?: string;
  readonly availableSkills: readonly SkillChoice[];
  readonly mode?: ClarifyMode;
}
