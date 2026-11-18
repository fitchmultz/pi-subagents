import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import {
  CustomMessageComponent,
  DefaultResourceLoader,
  initTheme,
  keyHint,
  keyText,
  SettingsManager,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { registerCompactMessages } from "../../src/shared/compact-cards.ts";
import { getPiAgentDir } from "../../src/pi-intercom/agent-dir.ts";

function makeMessage(content: string, customType = "intercom_message") {
  return {
    role: "custom" as const,
    customType,
    content,
    display: true,
    timestamp: 1,
  };
}

function makeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}-line-${index + 1}`).join("\n");
}

function plainLines(component: Component, width = 80): string[] {
  return component.render(width).map(stripTerminalSequences);
}

function clickHeader(
  component: Component,
  headerToken: string,
  width = 80,
): {
  readonly press: TuiMouseEventResult | undefined;
  readonly click: TuiMouseEventResult | undefined;
} {
  const lines = plainLines(component, width);
  const y = lines.findIndex((line) => line.includes(headerToken));
  assert.ok(y >= 0, `Missing header ${headerToken} in:\n${lines.join("\n")}`);
  const row = lines[y];
  assert.ok(row !== undefined);
  const x = row.indexOf(headerToken);
  assert.ok(x >= 0);
  const baseEvent: Omit<TuiMouseEvent, "type"> = {
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  return {
    press: component.handleMouse?.({ ...baseEvent, type: "press" }),
    click: component.handleMouse?.({ ...baseEvent, type: "click" }),
  };
}

async function setupRenderer(): Promise<{
  readonly handlers: ReadonlyMap<string, readonly unknown[]>;
  readonly renderer: MessageRenderer;
  readonly theme: Theme;
}> {
  initTheme("dark");
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getPiAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerCompactMessages(pi, ["intercom_message", "agent-completion"]);
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.at(0);
  assert.ok(extension !== undefined);
  const renderer = extension.messageRenderers.get("intercom_message");
  assert.ok(renderer !== undefined);

  let activeTheme: Theme | undefined;
  const probe = new CustomMessageComponent(
    makeMessage("theme-probe"),
    (_message, _options, theme) => {
      activeTheme = theme;
      return;
    },
  );
  assert.ok(probe.render(80).length > 0);
  assert.ok(activeTheme !== undefined);

  return {
    handlers: extension.handlers,
    renderer,
    theme: activeTheme,
  };
}

nodeDescribe("registerCompactMessages", () => {
  nodeIt("registers renderers without session_start or session_shutdown listeners", async () => {
    const { handlers } = await setupRenderer();
    assert.equal(handlers.size, 0);
  });

  nodeIt(
    "toggles only the clicked message and clears stale overrides on global changes when compactView is undefined",
    async () => {
      const { renderer, theme } = await setupRenderer();
      const messageA = makeMessage(makeLines("alpha", 8));
      const messageB = makeMessage(makeLines("beta", 8));
      const baseOptions: MessageRenderOptions = {
        expanded: false,
        outputPad: 1,
        keyHint,
        keyText,
      };

      const cardA = renderer(messageA, baseOptions, theme);
      const cardB = renderer(messageB, baseOptions, theme);
      assert.ok(cardA !== undefined && cardB !== undefined);

      const initialA = plainLines(cardA).join("\n");
      const initialB = plainLines(cardB).join("\n");
      assert.match(initialA, /to expand/);
      assert.match(initialA, /alpha-line-4/);
      assert.match(initialA, /… 4 more lines/);
      assert.doesNotMatch(initialA, /alpha-line-8/);
      assert.match(initialB, /to expand/);
      assert.doesNotMatch(initialB, /beta-line-8/);

      // Clicking cardA toggles only cardA.
      const firstClick = clickHeader(cardA, "[intercom_message]");
      assert.ok(firstClick.press !== undefined && firstClick.click !== undefined);
      assert.equal(firstClick.press.handled, true);
      assert.equal(firstClick.click.handled, true);
      assert.equal(firstClick.click.render, true);

      const afterExpandA = plainLines(cardA).join("\n");
      const afterExpandB = plainLines(cardB).join("\n");
      assert.match(afterExpandA, /to collapse/);
      assert.match(afterExpandA, /alpha-line-8/);
      assert.doesNotMatch(afterExpandA, /… 4 more lines/);
      assert.match(afterExpandB, /to expand/);
      assert.doesNotMatch(afterExpandB, /beta-line-8/);

      // Clicking cardA again collapses only cardA back to the 4-row preview.
      clickHeader(cardA, "[intercom_message]");
      const afterCollapseA = plainLines(cardA).join("\n");
      assert.match(afterCollapseA, /to expand/);
      assert.match(afterCollapseA, /… 4 more lines/);
      assert.doesNotMatch(afterCollapseA, /alpha-line-8/);

      // A global toggle (e.g. Ctrl+O) supersedes a per-card click override and does not resurrect it.
      clickHeader(cardA, "[intercom_message]");
      assert.match(plainLines(cardA).join("\n"), /alpha-line-8/);

      const globalExpandedA = renderer(messageA, { ...baseOptions, expanded: true }, theme);
      assert.ok(globalExpandedA !== undefined);
      assert.match(plainLines(globalExpandedA).join("\n"), /to collapse/);
      assert.match(plainLines(globalExpandedA).join("\n"), /alpha-line-8/);

      const globalCollapsedA = renderer(messageA, { ...baseOptions, expanded: false }, theme);
      assert.ok(globalCollapsedA !== undefined);
      const resetText = plainLines(globalCollapsedA).join("\n");
      assert.match(resetText, /to expand/);
      assert.doesNotMatch(resetText, /alpha-line-8/);

      // Starting globally expanded: clicking cardA collapses only cardA while cardB stays expanded.
      const expandedA = renderer(messageA, { ...baseOptions, expanded: true }, theme);
      const expandedB = renderer(messageB, { ...baseOptions, expanded: true }, theme);
      assert.ok(expandedA !== undefined && expandedB !== undefined);
      assert.match(plainLines(expandedA).join("\n"), /alpha-line-8/);
      assert.match(plainLines(expandedB).join("\n"), /beta-line-8/);

      clickHeader(expandedA, "[intercom_message]");
      assert.match(plainLines(expandedA).join("\n"), /to expand/);
      assert.doesNotMatch(plainLines(expandedA).join("\n"), /alpha-line-8/);
      assert.match(plainLines(expandedB).join("\n"), /to collapse/);
      assert.match(plainLines(expandedB).join("\n"), /beta-line-8/);

      // Short messages keep a plain header without expand/collapse hints.
      const shortCard = renderer(makeMessage(makeLines("short", 3)), baseOptions, theme);
      assert.ok(shortCard !== undefined);
      const shortText = plainLines(shortCard).join("\n");
      assert.match(shortText, /\[intercom_message\]/);
      assert.doesNotMatch(shortText, /to expand|to collapse|more lines/);
    },
  );

  nodeIt(
    "renders a non-intercepting Text header when options.compactView is defined so left clicks bubble",
    async () => {
      const { renderer, theme } = await setupRenderer();
      for (const compactView of [false, true]) {
        const message = makeMessage(makeLines("fork", 8));
        const collapsedOptions: MessageRenderOptions & { compactView: boolean } = {
          expanded: false,
          outputPad: 1,
          compactView,
          keyHint,
          keyText,
        };
        const card = renderer(message, collapsedOptions, theme);
        assert.ok(card !== undefined);

        const collapsed = plainLines(card).join("\n");
        assert.match(collapsed, /to expand/);
        assert.match(collapsed, /fork-line-4/);
        assert.match(collapsed, /… 4 more lines/);
        assert.doesNotMatch(collapsed, /fork-line-8/);

        const result = clickHeader(card, "[intercom_message]");
        assert.equal(result.press, undefined);
        assert.equal(result.click, undefined);

        const expandedOptions: MessageRenderOptions & { compactView: boolean } = {
          ...collapsedOptions,
          expanded: true,
        };
        const expandedCard = renderer(message, expandedOptions, theme);
        assert.ok(expandedCard !== undefined);
        const expanded = plainLines(expandedCard).join("\n");
        assert.match(expanded, /to collapse/);
        assert.match(expanded, /fork-line-8/);
      }
    },
  );

  nodeIt(
    "toggles a single CustomMessageComponent independently on click across official and fork hosts",
    async () => {
      const { renderer } = await setupRenderer();
      const componentA = new CustomMessageComponent(makeMessage(makeLines("one", 8)), renderer);
      const componentB = new CustomMessageComponent(makeMessage(makeLines("two", 8)), renderer);

      assert.doesNotMatch(plainLines(componentA).join("\n"), /one-line-8/);
      assert.doesNotMatch(plainLines(componentB).join("\n"), /two-line-8/);

      clickHeader(componentA, "[intercom_message]");
      assert.match(plainLines(componentA).join("\n"), /one-line-8/);
      assert.doesNotMatch(plainLines(componentB).join("\n"), /two-line-8/);

      clickHeader(componentA, "[intercom_message]");
      assert.doesNotMatch(plainLines(componentA).join("\n"), /one-line-8/);
      assert.doesNotMatch(plainLines(componentB).join("\n"), /two-line-8/);

      clickHeader(componentA, "[intercom_message]");
      assert.match(plainLines(componentA).join("\n"), /one-line-8/);

      componentA.setExpanded(true);
      assert.match(plainLines(componentA).join("\n"), /one-line-8/);
      componentA.setExpanded(false);
      assert.doesNotMatch(plainLines(componentA).join("\n"), /one-line-8/);
    },
  );
});
