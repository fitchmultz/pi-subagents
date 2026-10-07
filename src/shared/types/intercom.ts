import type { PublicNestedRunSummary } from "./nested.ts";
import type { SubagentResultStatus, SubagentRunMode } from "./progress.ts";

export interface SubagentResultIntercomChild {
  readonly agent: string;
  readonly status: SubagentResultStatus;
  readonly summary: string;
  readonly index?: number;
  readonly artifactPath?: string;
  readonly metadataPath?: string;
  readonly sessionPath?: string;
  readonly intercomTarget?: string;
  readonly children?: readonly PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
  readonly completionId?: string;
  readonly to: string;
  readonly message: string;
  readonly requestId?: string;
  readonly runId: string;
  readonly mode: SubagentRunMode;
  readonly status: SubagentResultStatus;
  readonly summary: string;
  readonly error?: string;
  readonly source: "foreground" | "async";
  readonly children: readonly SubagentResultIntercomChild[];
  readonly resultPath?: string;
  readonly asyncId?: string;
  readonly asyncDir?: string;
  readonly chainSteps?: number;
  readonly agent?: string;
  readonly index?: number;
  readonly artifactPath?: string;
  readonly sessionPath?: string;
}

export interface IntercomEventBus {
  readonly on: (channel: string, handler: (data: unknown) => void) => () => void;
  readonly emit: (channel: string, data: unknown) => void;
}

export interface SubagentIntercomConnection {
  readonly status: "connected" | "disconnected" | "connecting" | "unknown";
  readonly sessionId?: string;
  readonly reason?: string;
}

export interface SubagentLiveIntercomHealth {
  readonly target: string;
  readonly status: "registered" | "none" | "missing" | "ambiguous" | "prefix_too_short";
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly sessionStatus?: string;
  readonly acceptsAsks?: boolean;
  readonly pendingAsks?: number;
}
