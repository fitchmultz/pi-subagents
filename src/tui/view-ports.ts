import type { TUI, KeyId } from "@earendil-works/pi-tui";
import type { HistoryPage, HistoryPageInput, HistoryRunPage } from "../shared/types.ts";
import type { AgentHistory, AgentHistoryItem } from "./history-display.ts";
import type { AgentTask, AgentVisit } from "./view-model.ts";

export interface HistorySelection {
  readonly history: AgentHistory;
  readonly page: HistoryPage;
  readonly latestPage: boolean;
  readonly readThroughSequence?: number;
}
/** Browsing operations exposed to the native picker, not the controller's private state. */
export interface PickerController {
  readonly shortcut: KeyId;
  readonly tasks: readonly Readonly<AgentTask>[];
  readonly listFilter: string;
  readonly listPending: boolean;
  readonly listPage?: HistoryRunPage;
  readonly listError?: string;
  readonly listLoading: boolean;
  readonly availableHeight: (tui: TUI) => number;
  readonly task: (key: string) => Readonly<AgentTask> | undefined;
  readonly pageTasks: (direction: "earlier" | "later") => void;
  readonly retry: (key?: string) => Promise<void>;
  readonly filterTasks: (text: string) => void;
}
/** The conversation controls the actual visit/cache owner through its public operations. */
export interface ConversationController {
  readonly shortcut: KeyId;
  readonly pinned?: string;
  readonly availableHeight: (tui: TUI) => number;
  readonly task: (key: string) => Readonly<AgentTask> | undefined;
  readonly visit: (key: string) => AgentVisit;
  readonly changed: () => void;
  readonly historyPage: (
    key: string,
    paging?: Pick<HistoryPageInput, "before" | "after" | "cursor">,
    anchor?: string | null,
  ) => Promise<HistorySelection | undefined>;
  readonly savedResult: (key: string, id: string) => Promise<AgentHistoryItem>;
  readonly applyHistoryPage: (
    key: string,
    history: AgentHistory,
    page: HistoryPage,
    sourceSeen: boolean,
  ) => void;
  readonly setHistoryLoading: (key: string, loading: boolean) => void;
  readonly send: (key: string, text: string, continueExplicitly?: boolean) => Promise<void>;
  readonly stop: (key: string) => Promise<void>;
  readonly changes: (key: string) => Promise<AgentHistoryItem | undefined>;
  readonly isBusy: (key: string) => boolean;
  readonly retry: (key?: string) => Promise<void>;
  readonly pin: (key: string | undefined) => void;
}
