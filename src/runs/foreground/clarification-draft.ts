import type { ResolvedStepBehavior } from "../../shared/types/workflow.ts";
import type { BehaviorOverride, EditMode } from "./clarify-contracts.ts";

/** Owns replace-only preview values and downstream output/read dependencies. */
function resolveList(value: readonly string[] | false): string[] | false {
  return value === false ? false : [...value];
}
export class ClarificationDraft {
  private readonly templateValues: string[];
  get templates(): readonly string[] {
    return this.templateValues;
  }
  private readonly behaviors: readonly ResolvedStepBehavior[];
  private readonly overrides = new Map<number, BehaviorOverride>();
  constructor(templates: readonly string[], behaviors: readonly ResolvedStepBehavior[]) {
    this.templateValues = [...templates];
    this.behaviors = behaviors;
  }
  behavior(index: number): ResolvedStepBehavior {
    const base = this.behaviors.at(index);
    if (!base) {
      throw new Error(`Missing clarification behavior for step ${index}.`);
    }
    const override = this.overrides.get(index);
    return {
      ...base,
      ...override,
      reads: resolveList(override?.reads ?? base.reads),
      skills: resolveList(override?.skills ?? base.skills),
    };
  }
  override(index: number): BehaviorOverride | undefined {
    return this.overrides.get(index);
  }
  update(index: number, override: BehaviorOverride): void {
    this.overrides.set(index, { ...this.overrides.get(index), ...override });
  }
  toggleProgress(): void {
    const enabled = this.behaviors.some((_, index) => this.behavior(index).progress);
    this.behaviors.forEach((_, index) => {
      this.update(index, { progress: !enabled });
    });
  }
  save(index: number, field: EditMode, text: string): void {
    if (field === "template") {
      const lines = (this.templateValues[index] ?? "").split("\n");
      lines[0] = text;
      this.templateValues[index] = lines.join("\n");
      return;
    }
    if (field === "reads") {
      const reads = text
        .trim()
        .split(",")
        .map((file) => file.trim())
        .filter((file) => file.length > 0);
      this.update(index, { reads: reads.length > 0 ? reads : false });
      return;
    }
    if (field === "output") {
      this.saveOutput(index, text.trim());
    }
  }
  private saveOutput(index: number, text: string): void {
    const previous = this.behavior(index).output;
    const output = text.length === 0 ? false : text;
    this.update(index, { output });
    if (
      typeof previous === "string" &&
      previous.length > 0 &&
      typeof output === "string" &&
      previous !== output
    ) {
      this.propagateOutput(index, previous, output);
    }
  }
  private propagateOutput(index: number, previous: string, output: string): void {
    for (let next = index + 1; next < this.behaviors.length; next++) {
      const reads = this.behavior(next).reads;
      if (reads === false) {
        continue;
      }
      const found = reads.indexOf(previous);
      if (found < 0) {
        continue;
      }
      const updated = [...reads];
      updated[found] = output;
      this.update(next, { reads: updated });
    }
  }
}
