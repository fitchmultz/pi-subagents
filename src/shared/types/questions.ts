import type { ResolvedAcceptanceConfig } from "./acceptance.ts";
import type { JsonSchemaObject, OutputMode } from "./config.ts";
import type { SavedLaunchConfig } from "./launch.ts";
import type { ReadonlyAgentProgress } from "./progress.ts";
import type { ReadonlySingleResult } from "./results.ts";

export interface SupervisorRunContract {
  readonly legacySource?: string;
  readonly recordVersion?: 3;
  readonly nativeSessionId?: string;
  readonly terminalLeafId?: string | null;
  readonly terminalEntryId?: string;
  readonly attemptBaseline?: readonly string[];
  readonly baselineSource?: "native-migration";
  readonly effectiveConfiguration?: {
    readonly model?: string;
    readonly thinking?: string;
    readonly modelRecordedAt?: number;
  };
  readonly accounting?: { readonly state: "complete" | "incomplete"; readonly error?: string };
  readonly auditPath?: string;
  readonly task?: string;
  readonly label?: string;
  readonly result?: ReadonlySingleResult;
  readonly effectiveAcceptance?: ResolvedAcceptanceConfig;
  readonly output?: string | false;
  readonly outputMode?: OutputMode;
  readonly outputSchema?: JsonSchemaObject;
  readonly launch?: SavedLaunchConfig;
  /** Retained independently of progress after detachment. */
  readonly modelSelection?: Pick<ReadonlyAgentProgress, "model" | "thinking" | "modelStartedAt">;
  readonly sessionFile?: string;
  readonly pid?: number;
  readonly processIdentity?: string;
  readonly updatedAt?: number;
}

export interface SupervisorQuestion extends SupervisorRunContract {
  readonly questionId: string;
  readonly runId: string;
  readonly ownerSessionId: string;
  readonly ownerTarget: string;
  readonly agent: string;
  readonly index: number;
  readonly childSessionId: string;
  readonly childTarget: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly reason: "need_decision" | "interview_request";
  readonly message: string;
  readonly interview?: unknown;
}

export interface QuestionAnswer {
  readonly message: string;
  readonly answeredAt: number;
  readonly origin?: "human";
}

export interface QuestionDelivery {
  readonly kind: "live" | "revive";
  readonly runId: string;
  readonly deliveredAt: number;
}

export interface SupervisorQuestionView extends SupervisorQuestion {
  readonly state: "awaiting_input" | "answer_pending" | "answered" | "cancelled";
  readonly answer?: QuestionAnswer;
  readonly delivery?: QuestionDelivery;
  readonly revival?: { readonly runId: string; readonly pid: number; readonly startedAt: number };
}
