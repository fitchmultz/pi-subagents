import type { AgentTaskStore } from "./task-store.ts";
import type { AgentBrowser } from "./agent-browser.ts";
import type { AgentControls } from "./agent-controls.ts";
import type { ConversationController, PickerController } from "./view-ports.ts";

type Layout = Pick<PickerController, "shortcut" | "availableHeight">;
type ConversationUI = Layout & Pick<ConversationController, "changed" | "pin">;

/** Bind native UI ports directly to the owners of their operations and observations. */
export function pickerPort(
  store: AgentTaskStore,
  browser: AgentBrowser,
  layout: Layout,
): PickerController {
  return {
    ...layout,
    get tasks() {
      return store.tasks;
    },
    get listFilter() {
      return browser.listFilter;
    },
    get listPending() {
      return browser.listPending;
    },
    get listPage() {
      return browser.listPage;
    },
    get listError() {
      return browser.listError;
    },
    get listLoading() {
      return browser.listLoading;
    },
    task: store.task.bind(store),
    pageTasks: browser.pageTasks.bind(browser),
    retry: browser.retry.bind(browser),
    filterTasks: browser.filterTasks.bind(browser),
  };
}
export function conversationPort(
  store: AgentTaskStore,
  browser: AgentBrowser,
  controls: AgentControls,
  ui: ConversationUI,
): ConversationController {
  return {
    ...ui,
    get pinned() {
      return store.pinned;
    },
    task: store.task.bind(store),
    visit: store.visit.bind(store),
    historyPage: browser.historyPage.bind(browser),
    savedResult: browser.savedResult.bind(browser),
    applyHistoryPage: store.applyHistoryPage.bind(store),
    setHistoryLoading: store.setHistoryLoading.bind(store),
    send: controls.send.bind(controls),
    stop: controls.stop.bind(controls),
    changes: controls.changes.bind(controls),
    isBusy: controls.isBusy.bind(controls),
    retry: browser.retry.bind(browser),
  };
}
