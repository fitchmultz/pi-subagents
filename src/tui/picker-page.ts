import { visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type { PickerController } from "./view-ports.ts";
import { short, taskSummary, type AgentTask } from "./view-model.ts";
import { hasText } from "./text-values.ts";
export interface PickerPage {
  readonly items: readonly Readonly<SelectItem>[];
  readonly task?: Readonly<AgentTask>;
  readonly status: string;
  readonly selectedIndex: number;
}
function pageStatus(controller: PickerController): string {
  if (controller.listError !== undefined) {
    return controller.listError;
  }
  if (controller.listPage?.freshness.state === "catching-up") {
    return "Catching up · partial results";
  }
  if (controller.listPage?.freshness.state === "degraded") {
    return "Some history unavailable · F5 retry";
  }
  return controller.listLoading ? "Loading…" : "";
}
function pageItems(
  controller: PickerController,
  query: string,
): { readonly tasks: readonly AgentTask[]; readonly items: SelectItem[] } {
  const rows = controller.listPage?.rows ?? [];
  const tasks = controller.tasks.filter((task) => rows.some((run) => run.runId === task.run.runId));
  const items = tasks.map((task) => {
    const { status, badge } = taskSummary(task);
    return {
      value: task.key,
      label: `${task.child.agent} · ${task.label}`,
      description: status + badge,
    };
  });
  if ((controller.listPage?.offset ?? 0) > 0) {
    items.push({ value: "previous-page", label: "Previous agents", description: "PgUp" });
  }
  if (controller.listPage?.nextOffset !== undefined) {
    items.push({ value: "next-page", label: "More agents", description: "PgDn" });
  }
  items.push({ value: "retry", label: "Refresh / retry history", description: "F5" });
  if (!hasText(query)) {
    items.push({ value: "peers", label: "Other connected sessions", description: "All projects" });
  }
  return { tasks, items };
}
export function pickerPage(
  controller: PickerController,
  query: string,
  innerWidth: number,
  selected: string | undefined,
): PickerPage {
  const { tasks, items } = pageItems(controller, query);
  const labelWidth = Math.min(
    Math.max(0, ...items.map((item) => visibleWidth(item.label))),
    Math.max(40, Math.floor(innerWidth / 2)),
  );
  for (const [index, task] of tasks.entries()) {
    const item = items.at(index);
    if (!item) {
      continue;
    }
    const modelWidth = innerWidth - labelWidth - visibleWidth(item.description ?? "") - 7;
    if (modelWidth >= 16) {
      item.description = `${item.description ?? ""} · ${short(task.model.summary, modelWidth)}`;
    }
  }
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.value === selected),
  );
  return {
    items,
    selectedIndex,
    task: controller.task(items.at(selectedIndex)?.value ?? ""),
    status: pageStatus(controller),
  };
}
