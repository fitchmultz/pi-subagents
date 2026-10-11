import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ResolvedStepBehavior } from "../../shared/types/workflow.ts";
interface PreviewStep {
  readonly name: string;
  readonly label: string;
  readonly template: string;
  readonly model: string;
  readonly modelOverridden: boolean;
  readonly behavior: ResolvedStepBehavior;
  readonly nextUsesPrevious: boolean;
}
interface Preview {
  readonly mode: "single" | "parallel" | "chain";
  readonly selected: number;
  readonly background: boolean;
  readonly originalTask: string;
  readonly chainDir?: string;
  readonly progress: boolean;
  readonly notice?: string;
  readonly steps: readonly PreviewStep[];
}
/** Stateless presentation of clarification snapshots; it cannot change draft or launch state. */
export class ClarifyView {
  private readonly theme: Theme;
  private readonly width: number;
  constructor(theme: Theme, width: number) {
    this.theme = theme;
    this.width = width;
  }
  private row(content: string): string {
    const inner = this.width - 2;
    const clipped = truncateToWidth(content, inner, "…", true);
    return (
      this.theme.fg("border", "│") +
      clipped +
      " ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
      this.theme.fg("border", "│")
    );
  }
  private border(text: string, footer = false): string {
    const inner = this.width - 2;
    const clipped = truncateToWidth(` ${text} `, inner, "", true);
    const padding = Math.max(0, inner - visibleWidth(clipped));
    const left = Math.floor(padding / 2);
    return (
      this.theme.fg("border", `${footer ? "╰" : "╭"}${"─".repeat(left)}`) +
      this.theme.fg(footer ? "dim" : "accent", clipped) +
      this.theme.fg("border", `${"─".repeat(padding - left)}${footer ? "╯" : "╮"}`)
    );
  }
  editor(
    title: string,
    preview: { readonly lines: readonly string[]; readonly scrollInfo: string },
  ): string[] {
    const footer =
      preview.scrollInfo.length > 0
        ? `[Esc] Done • [Ctrl+C] Discard • ${preview.scrollInfo}`
        : "[Esc] Done • [Ctrl+C] Discard";
    return [
      this.border(title),
      this.row(""),
      ...preview.lines.map((line) => this.row(` ${line}`)),
      this.row(""),
      this.border(footer, true),
    ];
  }
  selector(input: {
    readonly title: string;
    readonly subtitles: readonly string[];
    readonly choices: readonly string[];
    readonly selected: number;
    readonly footer: string;
    readonly targetHeight?: number;
  }): string[] {
    const lines = [
      this.border(input.title),
      ...input.subtitles.map((line) => this.row(` ${line}`)),
      this.row(""),
      ...this.choices(input.choices, input.selected),
    ];
    const height = input.targetHeight ?? 18;
    while (lines.length < height) {
      lines.push(this.row(""));
    }
    lines.push(this.border(input.footer, true));
    return lines;
  }
  thinking(input: {
    readonly step: string;
    readonly model: string;
    readonly levels: readonly ThinkingLevel[];
    readonly selected: number;
  }): string[] {
    const descriptions: Readonly<Record<ThinkingLevel, string>> = {
      off: "No extended thinking",
      minimal: "Brief reasoning",
      low: "Light reasoning",
      medium: "Moderate reasoning",
      high: "Deep reasoning",
      xhigh: "Extra-high reasoning (ultrathink)",
      max: "Maximum reasoning",
    };
    return this.selector({
      title: `Thinking Level (${input.step})`,
      subtitles: [`Model: ${input.model}`],
      choices: input.levels.map((level) => `${level} - ${descriptions[level]}`),
      selected: input.selected,
      footer: "[Enter] Select • [Esc] Cancel • ↑↓ Navigate",
      targetHeight: 16,
    });
  }
  private choices(choices: readonly string[], selected: number): string[] {
    if (choices.length === 0) {
      return [this.row(" No matching choices")];
    }
    const start = Math.min(Math.max(0, selected - 5), Math.max(0, choices.length - 10));
    const lines: string[] = [];
    if (start > 0) {
      lines.push(this.row(`   ↑ ${start} more`));
    }
    choices.slice(start, start + 10).forEach((choice, index) => {
      const active = start + index === selected;
      lines.push(
        this.row(` ${active ? "→ " : "  "}${this.theme.fg(active ? "accent" : "text", choice)}`),
      );
    });
    const remaining = choices.length - start - 10;
    if (remaining > 0) {
      lines.push(this.row(`   ↓ ${remaining} more`));
    }
    return lines;
  }
  overview(input: Preview): string[] {
    const lines = [this.border(this.title(input)), this.row("")];
    if (input.mode === "chain") {
      lines.push(
        this.row(` Original Task: ${input.originalTask}`),
        this.row(` Chain Dir: ${input.chainDir ?? ""}`),
        this.row(` Progress: ${input.progress ? "enabled" : "disabled"} (press [p] to toggle)`),
        this.row(""),
      );
    }
    input.steps.forEach((step, index) => {
      lines.push(...this.step(step, index, input));
    });
    if (input.notice !== undefined) {
      lines.push(this.row(` ${this.theme.fg("success", input.notice)}`));
    }
    const fields = this.shortcuts(input.mode);
    const navigation = input.mode === "single" ? "" : " • ↑↓ Nav";
    lines.push(
      this.border(
        `[Enter] Run • [Esc] Cancel • ${fields} [b]g${input.background ? ":ON" : ""}${navigation}`,
        true,
      ),
    );
    return lines;
  }
  private title(input: Preview): string {
    if (input.mode === "parallel") {
      return `Parallel Tasks (${input.steps.length})`;
    }
    const label = input.mode === "single" ? "Agent" : "Chain";
    return `${label}: ${input.steps.map((step) => step.name).join(" → ")}`;
  }
  private shortcuts(mode: Preview["mode"]): string {
    if (mode === "chain") {
      return "e m t w r p s";
    }
    return mode === "single" ? "e m t w s" : "e m t s";
  }
  private stepHeading(label: string, active: boolean): string {
    return this.theme.fg(active ? "accent" : "dim", `${active ? "▶ " : "  "}${label}`);
  }
  private step(step: PreviewStep, index: number, input: Preview): string[] {
    const heading = this.stepHeading(step.label, index === input.selected);
    const task =
      input.mode === "chain"
        ? step.template
            .replace(/\{task\}/g, this.theme.fg("success", "{task}"))
            .replace(/\{previous\}/g, this.theme.fg("warning", "{previous}"))
            .replace(/\{chain_dir\}/g, this.theme.fg("accent", "{chain_dir}"))
        : step.template;
    const model = step.modelOverridden
      ? this.theme.fg("warning", step.model) + this.theme.fg("dim", " ✎")
      : step.model;
    const lines = [
      this.row(` ${heading}`),
      this.row(`     task: ${task}`),
      this.row(`     model: ${model}`),
    ];
    if (input.mode !== "parallel") {
      lines.push(this.row(`     writes: ${displayOutput(step.behavior.output)}`));
    }
    if (input.mode === "chain") {
      lines.push(this.row(`     reads: ${displayList(step.behavior.reads)}`));
    }
    lines.push(this.row(`     skills: ${displayList(step.behavior.skills)}`));
    if (input.mode === "chain" && input.progress) {
      lines.push(this.row(`     progress: ${index === 0 ? "writes" : "reads"} progress.md`));
    }
    if (input.mode === "chain" && step.nextUsesPrevious) {
      lines.push(this.row("     ↳ response → {previous}"));
    }
    lines.push(this.row(""));
    return lines;
  }
}
function displayOutput(output: string | false | undefined): string {
  if (output === false) {
    return "(disabled)";
  }
  return output === undefined || output.length === 0 ? "(none)" : output;
}
function displayList(values: readonly string[] | false): string {
  if (values === false) {
    return "(disabled)";
  }
  return values.length > 0 ? values.join(", ") : "(none)";
}
