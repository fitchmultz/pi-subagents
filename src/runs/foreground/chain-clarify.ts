import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ClarifyView } from "./clarify-view.ts";
import {
  findModelInfo,
  getSupportedThinkingLevels,
  type ModelInfo,
  type ThinkingLevel,
} from "../../shared/model-info.ts";
import { resolveModelCandidate, splitThinkingSuffix } from "../shared/model-fallback.ts";
import { ClarifyTextEditor } from "./clarify-text-editor.ts";
import { ClarificationDraft } from "./clarification-draft.ts";

import type {
  ChainClarifyResult,
  ChainClarifyOptions,
  ClarifyMode,
  EditMode,
} from "./clarify-contracts.ts";
export type {
  BehaviorOverride,
  ChainClarifyResult,
  ChainClarifyOptions,
} from "./clarify-contracts.ts";
type SkillChoice = ChainClarifyOptions["availableSkills"][number];

/** Owns one preview interaction. Edits replace local values; launch inputs are never mutated. */
export class ChainClarifyComponent implements Component {
  private renderWidth = 84;
  private selectedStep = 0;
  private editingStep: number | null = null;
  private editMode: EditMode = "template";
  private readonly editor = new ClarifyTextEditor();
  private readonly draft: ClarificationDraft;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: ChainClarifyOptions;
  private readonly done: (result: ChainClarifyResult) => void;
  private modelSearchQuery = "";
  private modelSelectedIndex = 0;
  private filteredModels: readonly ModelInfo[];
  private thinkingSelectedIndex = 0;
  private skillSearchQuery = "";
  private readonly skillSelectedNames = new Set<string>();
  private skillCursorIndex = 0;
  private filteredSkills: readonly SkillChoice[];
  private noticeMessage: string | undefined;
  private noticeMessageTimer: ReturnType<typeof setTimeout> | undefined;
  private runInBackground = false;
  private readonly mode: ClarifyMode;

  constructor(
    tui: TUI,
    theme: Theme,
    options: ChainClarifyOptions,
    done: (result: ChainClarifyResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.done = done;
    this.draft = new ClarificationDraft(options.templates, options.resolvedBehaviors);
    this.filteredModels = options.availableModels;
    this.filteredSkills = options.availableSkills;
    this.mode = options.mode ?? "chain";
  }
  private getEffectiveModel(index: number): string {
    const model = this.draft.behavior(index).model;
    if (model === undefined || model.length === 0) {
      return "default";
    }
    return (
      resolveModelCandidate(model, this.options.availableModels, this.options.preferredProvider) ??
      model
    );
  }
  private exitEditMode(): void {
    this.editingStep = null;
    this.editor.setText("");
    this.tui.requestRender();
  }
  private showNotice(text: string): void {
    this.noticeMessage = text;
    if (this.noticeMessageTimer !== undefined) {
      clearTimeout(this.noticeMessageTimer);
    }
    this.noticeMessageTimer = setTimeout(() => {
      this.noticeMessage = undefined;
      this.noticeMessageTimer = undefined;
      this.tui.requestRender();
    }, 2000);
    this.tui.requestRender();
  }
  handleInput(data: string): void {
    if (this.editingStep !== null) {
      this.handleEditingInput(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done({ confirmed: false, templates: [], behaviorOverrides: [] });
      return;
    }
    if (matchesKey(data, "return")) {
      this.done({
        confirmed: true,
        templates: [...this.draft.templates],
        behaviorOverrides: this.options.agentConfigs.map((_, index) => this.draft.override(index)),
        runInBackground: this.runInBackground,
      });
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      this.selectedStep = Math.max(
        0,
        Math.min(this.options.agentConfigs.length - 1, this.selectedStep + delta),
      );
    } else {
      this.handleShortcut(data);
    }
    this.tui.requestRender();
  }
  private handleShortcut(data: string): void {
    switch (data) {
      case "e":
        this.enterEditMode("template");
        break;
      case "m":
        this.enterModelSelector();
        break;
      case "t":
        this.enterThinkingSelector();
        break;
      case "s":
        this.enterSkillSelector();
        break;
      case "w":
        if (this.mode !== "parallel") {
          this.enterEditMode("output");
        }
        break;
      case "r":
        if (this.mode === "chain") {
          this.enterEditMode("reads");
        }
        break;
      case "p":
        if (this.mode === "chain") {
          this.draft.toggleProgress();
        }
        break;
      case "b":
        this.runInBackground = !this.runInBackground;
        break;
    }
  }
  private enterEditMode(mode: "template" | "output" | "reads"): void {
    this.editingStep = this.selectedStep;
    this.editMode = mode;
    const behavior = this.draft.behavior(this.selectedStep);
    let buffer = (this.draft.templates[this.selectedStep] ?? "").split("\n")[0] ?? "";
    if (mode === "output") {
      buffer = behavior.output === false ? "" : behavior.output;
    }
    if (mode === "reads") {
      buffer = behavior.reads === false ? "" : behavior.reads.join(", ");
    }
    this.editor.setText(buffer);
  }
  private enterModelSelector(): void {
    this.editingStep = this.selectedStep;
    this.editMode = "model";
    this.modelSearchQuery = "";
    this.filteredModels = this.options.availableModels;
    const current = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep)).baseModel;
    this.modelSelectedIndex = Math.max(
      0,
      this.filteredModels.findIndex((model) => model.fullId === current || model.id === current),
    );
    this.tui.requestRender();
  }
  private getAvailableThinkingLevels(index: number): ThinkingLevel[] {
    return getSupportedThinkingLevels(
      findModelInfo(
        this.getEffectiveModel(index),
        this.options.availableModels,
        this.options.preferredProvider,
      ),
    );
  }
  private enterThinkingSelector(): void {
    const model = this.draft.behavior(this.selectedStep).model;
    if (model === undefined || model.length === 0) {
      this.showNotice("Select a model first");
      return;
    }
    this.editingStep = this.selectedStep;
    this.editMode = "thinking";
    const levels = this.getAvailableThinkingLevels(this.selectedStep);
    const suffix = splitThinkingSuffix(
      this.getEffectiveModel(this.selectedStep),
    ).thinkingSuffix.slice(1);
    const index = levels.findIndex((level) => level === suffix);
    this.thinkingSelectedIndex = index >= 0 ? index : Math.max(0, levels.indexOf("off"));
    this.tui.requestRender();
  }
  private applyThinkingLevel(level: ThinkingLevel): void {
    if (this.editingStep === null) {
      return;
    }
    const current = this.draft.behavior(this.editingStep).model;
    if (current === undefined || current.length === 0) {
      return;
    }
    const { baseModel } = splitThinkingSuffix(current);
    this.draft.update(this.editingStep, {
      model: level === "off" ? baseModel : `${baseModel}:${level}`,
    });
  }
  private enterSkillSelector(): void {
    this.editingStep = this.selectedStep;
    this.editMode = "skills";
    this.skillSearchQuery = "";
    this.skillCursorIndex = 0;
    this.filteredSkills = this.options.availableSkills;
    this.skillSelectedNames.clear();
    const skills = this.draft.behavior(this.selectedStep).skills;
    if (skills !== false) {
      skills.forEach((skill) => {
        this.skillSelectedNames.add(skill);
      });
    }
  }
  private handleEditingInput(data: string): void {
    if (this.editMode === "model") {
      this.handleModelSelectorInput(data);
      return;
    }
    if (this.editMode === "thinking") {
      this.handleThinkingSelectorInput(data);
      return;
    }
    if (this.editMode === "skills") {
      this.handleSkillSelectorInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.saveEdit();
      this.exitEditMode();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.exitEditMode();
      return;
    }
    this.editor.handleInput(data, this.renderWidth - 4);
    this.tui.requestRender();
  }
  private handleModelSelectorInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.exitEditMode();
      return;
    }
    if (matchesKey(data, "return")) {
      this.selectModel();
      this.exitEditMode();
      return;
    }
    const direction = navigationDirection(data);
    if (direction !== 0) {
      this.modelSelectedIndex = moveSelection(
        this.modelSelectedIndex,
        direction,
        this.filteredModels.length,
      );
    } else {
      this.modelSearchQuery = searchInput(this.modelSearchQuery, data);
      const query = this.modelSearchQuery.toLowerCase();
      this.filteredModels = this.options.availableModels.filter((model) =>
        `${model.fullId} ${model.id} ${model.provider}`.toLowerCase().includes(query),
      );
      this.modelSelectedIndex = Math.min(
        this.modelSelectedIndex,
        Math.max(0, this.filteredModels.length - 1),
      );
    }
    this.tui.requestRender();
  }
  private selectModel(): void {
    const selected = this.filteredModels.at(this.modelSelectedIndex);
    if (!selected || this.editingStep === null) {
      return;
    }
    const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.editingStep));
    const info = findModelInfo(
      selected.fullId,
      this.options.availableModels,
      this.options.preferredProvider,
    );
    const suffix = getSupportedThinkingLevels(info).some(
      (level) => level === thinkingSuffix.slice(1),
    )
      ? thinkingSuffix
      : "";
    this.draft.update(this.editingStep, { model: `${selected.fullId}${suffix}` });
  }
  private handleThinkingSelectorInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.exitEditMode();
      return;
    }
    if (this.editingStep === null) {
      return;
    }
    const levels = this.getAvailableThinkingLevels(this.editingStep);
    if (levels.length === 0) {
      return;
    }
    if (matchesKey(data, "return")) {
      this.applyThinkingLevel(levels[this.thinkingSelectedIndex] ?? "off");
      this.exitEditMode();
      return;
    }
    this.thinkingSelectedIndex = moveSelection(
      this.thinkingSelectedIndex,
      navigationDirection(data),
      levels.length,
    );
    this.tui.requestRender();
  }
  private handleSkillSelectorInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.exitEditMode();
      return;
    }
    if (matchesKey(data, "return") && this.editingStep !== null) {
      this.draft.update(this.editingStep, { skills: [...this.skillSelectedNames] });
      this.exitEditMode();
      return;
    }
    if (data === " ") {
      this.toggleSkill();
    } else {
      this.searchSkills(data);
    }
    this.tui.requestRender();
  }
  private toggleSkill(): void {
    const skill = this.filteredSkills.at(this.skillCursorIndex);
    if (!skill) {
      return;
    }
    if (this.skillSelectedNames.has(skill.name)) {
      this.skillSelectedNames.delete(skill.name);
    } else {
      this.skillSelectedNames.add(skill.name);
    }
  }
  private searchSkills(data: string): void {
    const direction = navigationDirection(data);
    if (direction !== 0) {
      this.skillCursorIndex = moveSelection(
        this.skillCursorIndex,
        direction,
        this.filteredSkills.length,
      );
      return;
    }
    this.skillSearchQuery = searchInput(this.skillSearchQuery, data);
    const query = this.skillSearchQuery.toLowerCase();
    this.filteredSkills = this.options.availableSkills.filter((skill) =>
      `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(query),
    );
    this.skillCursorIndex = Math.min(
      this.skillCursorIndex,
      Math.max(0, this.filteredSkills.length - 1),
    );
  }
  private saveEdit(): void {
    if (this.editingStep !== null) {
      this.draft.save(this.editingStep, this.editMode, this.editor.getText());
    }
  }
  private stepLabel(index: number): string {
    const agent = this.options.agentConfigs[index]?.name ?? "unknown";
    if (this.mode === "single") {
      return agent;
    }
    return `${this.mode === "parallel" ? "Task" : "Step"} ${index + 1}: ${agent}`;
  }
  render(width: number): string[] {
    if (width < 40) {
      return [truncateToWidth("Subagent clarify: widen terminal", width)];
    }
    this.renderWidth = Math.min(84, width);
    if (this.editingStep !== null) {
      return this.renderEditing();
    }
    return this.renderOverview();
  }
  private renderEditing(): string[] {
    if (this.editMode === "model") {
      return this.renderModelSelector();
    }
    if (this.editMode === "thinking") {
      return this.renderThinkingSelector();
    }
    if (this.editMode === "skills") {
      return this.renderSkillSelector();
    }
    const name = this.editMode === "template" ? "task" : this.editMode;
    const view = new ClarifyView(this.theme, this.renderWidth);
    return view.editor(
      `Editing ${name} (${this.stepLabel(this.editingStep ?? 0)})`,
      this.editor.render(this.renderWidth - 4, 12),
    );
  }
  private renderModelSelector(): string[] {
    const current = this.getEffectiveModel(this.editingStep ?? 0);
    const base = splitThinkingSuffix(current).baseModel;
    const choices = this.filteredModels.map(
      (model) =>
        `${model.id} [${model.provider}]${model.fullId === base || model.id === base ? " current" : ""}`,
    );
    return new ClarifyView(this.theme, this.renderWidth).selector({
      title: `Select Model (${this.stepLabel(this.editingStep ?? 0)})`,
      subtitles: [`Search: ${this.modelSearchQuery}\x1b[7m \x1b[27m`, `Current: ${current}`],
      choices,
      selected: this.modelSelectedIndex,
      footer: "[Enter] Select • [Esc] Cancel • Type to search",
    });
  }
  private renderThinkingSelector(): string[] {
    return new ClarifyView(this.theme, this.renderWidth).thinking({
      step: this.stepLabel(this.editingStep ?? 0),
      model: this.getEffectiveModel(this.editingStep ?? 0),
      levels: this.getAvailableThinkingLevels(this.editingStep ?? 0),
      selected: this.thinkingSelectedIndex,
    });
  }
  private renderSkillSelector(): string[] {
    const selected = [...this.skillSelectedNames].join(", ");
    const choices = this.filteredSkills.map(
      (skill) =>
        `${this.skillSelectedNames.has(skill.name) ? "[x]" : "[ ]"} ${skill.name} [${skill.source}] - ${truncateToWidth(skill.description ?? "", 25)}`,
    );
    return new ClarifyView(this.theme, this.renderWidth).selector({
      title: `Select Skills (${this.stepLabel(this.editingStep ?? 0)})`,
      subtitles: [
        `Search: ${this.skillSearchQuery}\x1b[7m \x1b[27m`,
        `Selected: ${selected.length > 0 ? selected : "(none)"}`,
      ],
      choices,
      selected: this.skillCursorIndex,
      footer: "[Enter] Confirm • [Space] Toggle • [Esc] Cancel",
    });
  }
  private renderOverview(): string[] {
    const progress = this.options.agentConfigs.some(
      (_, index) => this.draft.behavior(index).progress,
    );
    return new ClarifyView(this.theme, this.renderWidth).overview({
      mode: this.mode,
      selected: this.selectedStep,
      background: this.runInBackground,
      originalTask: this.options.originalTask,
      chainDir: this.options.chainDir,
      progress,
      notice: this.noticeMessage,
      steps: this.options.agentConfigs.map((agent, index) => ({
        name: agent.name,
        label: this.stepLabel(index),
        template: (this.draft.templates[index] ?? "").split("\n")[0] ?? "",
        model: this.getEffectiveModel(index),
        modelOverridden: this.draft.override(index)?.model !== undefined,
        behavior: this.draft.behavior(index),
        nextUsesPrevious: (this.draft.templates[index + 1] ?? "").includes("{previous}"),
      })),
    });
  }
  invalidate(): void {
    /* Rendering reads the current theme and owns no cache. */
  }
  dispose(): void {
    if (this.noticeMessageTimer !== undefined) {
      clearTimeout(this.noticeMessageTimer);
    }
    this.noticeMessageTimer = undefined;
  }
}
function navigationDirection(data: string): number {
  if (matchesKey(data, "up")) {
    return -1;
  }
  return matchesKey(data, "down") ? 1 : 0;
}
function moveSelection(index: number, direction: number, count: number): number {
  return count === 0 ? 0 : (index + direction + count) % count;
}
function searchInput(query: string, data: string): string {
  if (matchesKey(data, "backspace")) {
    return query.slice(0, -1);
  }
  return data.length === 1 && data.charCodeAt(0) >= 32 ? query + data : query;
}
