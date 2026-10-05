/** Observations from native journals and external runners are not necessarily complete SDK messages. */
export interface ObservedUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
}

export type ObservedContent =
  | { readonly type: "text"; readonly text: string; readonly textSignature?: string }
  | {
      readonly type: "thinking";
      readonly thinking: string;
      readonly thinkingSignature?: string;
      readonly redacted?: boolean;
    }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly thoughtSignature?: string;
      readonly namespace?: string;
    };

interface ObservedMessageMetadata {
  readonly timestamp?: number;
}

export type ObservedMessage =
  | (ObservedMessageMetadata & {
      readonly role: "assistant";
      readonly content: readonly ObservedContent[];
      readonly api?: string;
      readonly provider?: string;
      readonly model?: string;
      readonly responseModel?: string;
      readonly responseId?: string;
      readonly usage?: ObservedUsage;
      readonly stopReason?: string;
      readonly errorMessage?: string;
    })
  | (ObservedMessageMetadata & {
      readonly role: "toolResult";
      readonly content: readonly ObservedContent[];
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError?: boolean;
      readonly observedExitCode?: number;
      readonly usage?: ObservedUsage;
      readonly details?: unknown;
    })
  | (ObservedMessageMetadata & {
      readonly role: "user" | "system";
      readonly content: string | readonly ObservedContent[];
    })
  | (ObservedMessageMetadata & {
      readonly role: "custom";
      readonly customType: string;
      readonly content: string | readonly ObservedContent[];
      readonly display?: boolean;
      readonly details?: unknown;
    })
  | (ObservedMessageMetadata & {
      readonly role: "bashExecution";
      readonly command: string;
      readonly output: string;
      readonly exitCode?: number;
      readonly cancelled?: boolean;
      readonly truncated?: boolean;
      readonly fullOutputPath?: string;
      readonly excludeFromContext?: boolean;
      readonly content?: never;
    })
  | (ObservedMessageMetadata & {
      readonly role: "branchSummary";
      readonly summary: string;
      readonly fromId: string | null;
      readonly content?: never;
    })
  | (ObservedMessageMetadata & {
      readonly role: "compactionSummary";
      readonly summary: string;
      readonly tokensBefore: number;
      readonly content?: never;
    });
