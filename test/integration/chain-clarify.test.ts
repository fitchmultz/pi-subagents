import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
  ChainClarifyComponent,
  type ChainClarifyOptions,
} from "../../src/runs/foreground/chain-clarify.ts";
import { makeAgent } from "../support/helpers.ts";
import { createPlainTheme } from "../support/ui.ts";
import { createTestTerminal } from "../support/terminal.ts";

function stripAnsi(text: string): string {
  // Native terminal SGR sequences are protocol controls, not printable task text.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function preview(model: string | undefined, options: Readonly<Partial<ChainClarifyOptions>> = {}) {
  return new ChainClarifyComponent(
    new TuiMainScreen(createTestTerminal()),
    createPlainTheme(),
    {
      agentConfigs: [makeAgent("worker", { model })],
      templates: ["Task"],
      originalTask: "Task",
      resolvedBehaviors: [
        { output: false, outputMode: "inline", reads: false, progress: false, skills: [], model },
      ],
      availableModels: [],
      availableSkills: [],
      mode: "single",
      ...options,
    },
    () => {
      // These interaction checks inspect the preview; none launches an execution.
    },
  );
}

function chooseHigh(component: Readonly<ChainClarifyComponent>): void {
  component.handleInput("t");
  // The public menu is off, minimal, low, medium, high for these models.
  for (let index = 0; index < 4; index++) {
    component.handleInput("\x1b[B");
  }
  component.handleInput("\r");
}

function overview(component: Readonly<ChainClarifyComponent>): string {
  return component.render(84).map(stripAnsi).join("\n");
}

describe("chain clarify model display", () => {
  it("keeps the preferred provider visible after applying thinking to a bare model", () => {
    const component = preview("gpt-5-mini", {
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
        { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
      ],
      preferredProvider: "github-copilot",
    });
    assert.match(overview(component), /github-copilot\/gpt-5-mini/);
    chooseHigh(component);
    assert.match(overview(component), /github-copilot\/gpt-5-mini:high/);
  });

  it("shows only thinking levels supported by the selected model", () => {
    const component = preview("deepseek-v4-pro", {
      availableModels: [
        {
          provider: "deepseek",
          id: "deepseek-v4-pro",
          fullId: "deepseek/deepseek-v4-pro",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
      preferredProvider: "deepseek",
    });
    component.handleInput("t");
    const rendered = overview(component);
    assert.match(rendered, /off - No extended thinking/);
    assert.match(rendered, /high - Deep reasoning/);
    assert.match(rendered, /xhigh - Extra-high reasoning/);
    assert.match(rendered, /max - Maximum reasoning/);
    assert.doesNotMatch(rendered, /minimal - Brief reasoning/);
    assert.doesNotMatch(rendered, /low - Light reasoning/);
    assert.doesNotMatch(rendered, /medium - Moderate reasoning/);
  });

  it("drops thinking when switching to a model that does not support it", () => {
    const component = preview("reasoning-model", {
      availableModels: [
        {
          provider: "test",
          id: "reasoning-model",
          fullId: "test/reasoning-model",
          reasoning: true,
        },
        { provider: "test", id: "basic-model", fullId: "test/basic-model", reasoning: false },
      ],
      preferredProvider: "test",
    });
    chooseHigh(component);
    component.handleInput("m");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    assert.match(overview(component), /test\/basic-model/);
    assert.doesNotMatch(overview(component), /basic-model:high/);
  });

  it("does not expose persistent save shortcuts", () => {
    const component = preview(undefined, { mode: "chain" });
    const initial = overview(component);
    assert.doesNotMatch(initial, /\bS\b/);
    assert.doesNotMatch(initial, /\bW\b/);
    component.handleInput("W");
    assert.doesNotMatch(overview(component), /Save Chain/);
    component.handleInput("S");
    assert.doesNotMatch(overview(component), /Saved agent settings/);
  });

  it("wraps wide characters inside the runtime editor width", () => {
    const component = preview(undefined, { templates: ["界".repeat(60)] });
    component.handleInput("e");
    const lines = component.render(84).map(stripAnsi);
    assert.ok(
      lines.some((line) => line.includes("界")),
      "editor should render the wide-character task",
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 84, `line exceeded component width: ${line}`);
    }
  });

  it("keeps the current model selected and preserves thinking when switching models", () => {
    const component = preview("gpt-5-mini", {
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
        { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
        { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
        { provider: "github-copilot", id: "gpt-5", fullId: "github-copilot/gpt-5" },
      ],
      preferredProvider: "github-copilot",
    });
    chooseHigh(component);
    component.handleInput("m");
    component.handleInput("\r");
    assert.match(overview(component), /github-copilot\/gpt-5-mini:high/);
    component.handleInput("m");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    assert.match(overview(component), /github-copilot\/gpt-5:high/);
  });
});
