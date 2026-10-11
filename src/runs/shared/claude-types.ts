import type { ClaudeCodeModelSpec } from "./claude-model.ts";

export interface ClaudeCodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sessionId: string;
  readonly resuming: boolean;
  readonly model: ClaudeCodeModelSpec;
}

export interface ClaudeCodeResultEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: number | null;
  readonly result?: string;
  readonly stop_reason?: string;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly modelUsage?: Readonly<
    Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>
  >;
  readonly structured_output?: unknown;
}
