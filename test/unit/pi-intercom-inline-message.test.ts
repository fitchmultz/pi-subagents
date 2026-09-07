import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

import { createEventBus, createExtensionRuntime, CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerIntercomExtension from "../../src/pi-intercom/index.ts";
import { buildSubagentResultIntercomPayload } from "../../src/intercom/result-intercom.ts";
import { InlineMessageComponent } from "../../src/pi-intercom/ui/inline-message.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
};

const from: SessionInfo = {
  id: "session-12345678",
  name: "sender",
  cwd: "/tmp/project",
  model: "model",
};

const message: Message = {
  id: "message-1",
  timestamp: 0,
  content: {
    text: "This is a long message that should use the available terminal width instead of a narrow fixed card.",
  },
};

test("registered subagent completion messages honor native collapse and expand without changing peer messages", async (t) => {
  const { loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(registerIntercomExtension, process.cwd(), createEventBus(), runtime);
  const renderer = extension.messageRenderers.get("intercom_message");
  assert.ok(renderer, "exercise the actual registered message renderer, not just the component constructor");
  initTheme("dark", false);
  const { theme: nativeTheme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const { setKeybindings } = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
  setKeybindings(new KeybindingsManager());
  const unwrap = (lines: string[]) => lines.map(stripVTControlCharacters).map((line) => line.startsWith("│") ? line.slice(1, -1) : line).join("\n").replace(/\s/g, "");
  try {
    for (const status of ["completed", "failed", "paused", "timed-out"] as const) {
      const summary = `Long result: ${"café 中文 👩🏽‍💻 detailed evidence. ".repeat(40)}\n\nLast child response detail.`;
      const payload = buildSubagentResultIntercomPayload({
        to: "parent", runId: "f5b4b221-5c64-4bc7-9862-70a35d94dc9b", mode: "parallel", source: "async",
        children: [{ agent: "worker", index: 0, status, summary }, { agent: "reviewer", index: 1, status: "completed", summary: "Second child response." }],
      });
      const bodyText = payload.message;
      const customMessage = {
        role: "custom" as const, customType: "intercom_message", display: true, timestamp: 0,
        content: `**From subagent-result:**\n\n${bodyText}`,
        details: {
          from: { ...from, id: "subagent-result", name: "subagent-result", status: "result" },
          message: { ...message, content: { text: bodyText } }, bodyText,
        },
      };
      const original = structuredClone(customMessage);
      const component = new CustomMessageComponent(customMessage, renderer);
      for (const width of [120, 40, 80]) {
        const collapsed = component.render(width);
        const text = collapsed.map(stripVTControlCharacters).join("\n");
        assert.ok(collapsed.length <= 9, "completion cards must not render the full response while collapsed");
        assert.ok(collapsed.every((line) => visibleWidth(line) <= width));
        assert.match(text, /Run: f5b4b221/);
        assert.match(text, new RegExp(`Status: ${status}`));
        assert.match(text, /Children:/);
        assert.match(text, /ctrl\+o/i);
        assert.doesNotMatch(text, /Last child response detail/);
        component.setExpanded(true);
        const expanded = component.render(width);
        assert.ok(expanded.every((line) => visibleWidth(line) <= width));
        assert.ok(unwrap(expanded).includes(bodyText.replace(/\s/g, "")), "native expansion retains every child response and header");
        component.setExpanded(false);
        assert.deepEqual(component.render(width), collapsed);
      }
      assert.deepEqual(customMessage, original, "display choices must not alter model-visible message content or details");

      for (const details of [
        { ...customMessage.details, from },
        { ...customMessage.details, from: { ...from, name: "subagent-result" } },
        { ...customMessage.details, from: { ...from, id: "subagent-control", name: "subagent-control", status: "needs_attention" } },
        { ...customMessage.details, from: { ...customMessage.details.from, status: "needs_attention" } },
        { ...customMessage.details, message: { ...customMessage.details.message, expectsReply: true } },
        { ...customMessage.details, replyCommand: 'intercom({ action: "reply", message: "..." })' },
      ]) {
        const peer = new CustomMessageComponent({ ...customMessage, details }, renderer);
        const collapsed = peer.render(40);
        assert.ok(unwrap(collapsed).includes(bodyText.replace(/\s/g, "")), "ordinary peers, questions and control messages stay fully actionable");
        peer.setExpanded(true);
        assert.deepEqual(peer.render(40), collapsed);
      }
    }
    await t.test("direct compact Intercom previews preserve state, attachments and attention exceptions", () => {
      const bodyText = "Historical/deferred progress from completed child (completed); not new work.\nOriginally sent: earlier\nDelivered to Pi: later\n\nSubagent progress update.\n\n📎 notes.ts\nconst proof = 'café e\u0301 中文 👩🏽‍💻';\nLast attachment detail.";
      const received = {
        role: "custom" as const, customType: "intercom_message", display: true, timestamp: 0,
        content: bodyText,
        details: {
          from: { ...from, name: "worker" }, bodyText,
          message: { ...message, replyTo: "previous-message", content: { text: "Subagent progress update.", attachments: [{ type: "snippet" as const, name: "notes.ts", content: "Last attachment detail." }] } },
        },
      };
      const payload = buildSubagentResultIntercomPayload({
        to: "parent", runId: "f5b4b221-5c64-4bc7-9862-70a35d94dc9b", mode: "parallel", source: "async",
        children: [{ agent: "worker", index: 0, status: "failed", summary: "First child response." }, { agent: "reviewer", index: 1, status: "completed", summary: "Last child response." }],
      });
      const grouped = {
        ...received, content: payload.message,
        details: {
          from: { ...from, id: "subagent-result", name: "subagent-result", status: "result" }, bodyText: payload.message,
          message: { ...message, content: { text: payload.message } },
        },
      };
      const render = (entry: typeof received | typeof grouped, compactView?: boolean, expanded = false, outputPad = 1) => {
        const options = { expanded, outputPad, ...(compactView === undefined ? {} : { compactView }) };
        const component = renderer(entry, options, nativeTheme);
        assert.ok(component);
        return component;
      };
      for (const entry of [
        received,
        { ...received, details: { ...received.details, bodyText: "Peer update: café e\u0301 中文 👩🏽‍💻\r\n\tMore peer detail.", from: { ...from, name: "peer 中文 👩🏽‍💻" } } },
        grouped,
        { ...grouped, details: { ...grouped.details, subagentCompletion: { runId: payload.runId, status: payload.status, children: [{ agent: "worker", index: 0, status: "failed", intercomTarget: "worker" }], ownerSessionId: "parent" } } },
      ]) {
        const original = structuredClone(entry);
        for (const outputPad of [0, 2]) {
          const compact = render(entry, true, false, outputPad);
          for (const width of [120, 40, 2, 1, 3, 80]) {
            const lines = compact.render(width);
            assert.equal(lines.length, 1, "the registered compact renderer must return one content row, without a native wrapper");
            assert.ok(lines.every((line) => visibleWidth(line) <= width && !/[\r\n\t]/.test(line)));
            if (width >= 40 && outputPad > 0) assert.ok(lines[0]!.startsWith(" ".repeat(outputPad)));
            assert.deepEqual(render(entry, false, false, outputPad).render(width), render(entry, undefined, false, outputPad).render(width), "OFF and absent use the same presentation");
            compact.invalidate();
            assert.deepEqual(compact.render(width), lines);
            assert.deepEqual(render(entry, true, false, outputPad).render(width), lines, "OFF/ON cycles restore the compact view");
          }
        }
        const wide = render(entry, true).render(120).map(stripVTControlCharacters).join("\n");
        assert.match(wide, /ctrl\+o/i);
        assert.ok(wide.includes(entry.details.from.name!));
        if (entry.details.from.id === "subagent-result") {
          assert.match(wide, /failed/);
          assert.match(wide, /f5b4b221/);
          assert.doesNotMatch(wide, /1 child/);
        }
        for (const width of [40, 120]) {
          const expanded = render(entry, true, true).render(width);
          assert.deepEqual(expanded, render(entry, false, true).render(width), "compact mode never changes the expanded renderer");
          assert.ok(unwrap(expanded).includes(entry.details.bodyText.replace(/\s/g, "")));
        }
        assert.deepEqual(entry, original);
      }
      assert.match(render(received, true).render(120).map(stripVTControlCharacters).join("\n"), /Historical\/deferred progress/);
      for (const details of [
        { ...received.details, from: { ...from, id: "subagent-control" } },
        { ...received.details, from: { ...from, status: "needs_attention" } },
        { ...received.details, message: { ...received.details.message, expectsReply: true } },
        { ...received.details, replyCommand: 'intercom({ action: "reply", message: "..." })' },
      ]) {
        const entry = { ...received, details };
        const original = structuredClone(entry);
        const lines = render(entry, true).render(40);
        assert.deepEqual(lines, render(entry, false).render(40), "attention and reply guidance stay prominent");
        assert.ok(unwrap(lines).includes(bodyText.replace(/\s/g, "")));
        assert.deepEqual(entry, original);
      }
      setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+e"] }));
      try {
        assert.match(render(received, true).render(120).map(stripVTControlCharacters).join("\n"), /ctrl\+e/i);
      } finally {
        setKeybindings(new KeybindingsManager());
      }
    });
  } finally {
    runtime.invalidate();
  }
});

test("inline intercom messages render at the available terminal width", () => {
  const component = new InlineMessageComponent(from, message, theme as any);

  const lines = component.render(120);

  assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("inline intercom messages do not duplicate attachment labels when body text includes attachments", () => {
  const attachmentMessage: Message = {
    ...message,
    content: {
      text: "See attached snippet.",
      attachments: [{ type: "snippet", name: "example.ts", content: "const ok = true;", language: "typescript" }],
    },
  };
  const bodyText = "See attached snippet.\n\n---\n📎 example.ts\n~~~typescript\nconst ok = true;\n~~~";
  const component = new InlineMessageComponent(from, attachmentMessage, theme as any, undefined, bodyText);

  const text = component.render(120).join("\n");
  assert.equal((text.match(/📎 example\.ts/g) ?? []).length, 1);
  assert.match(text, /const ok = true/);
});

test("inline intercom messages cache the full output only at the latest width", () => {
  const bodyText = Array.from({ length: 120 }, (_, index) =>
    `Line ${index}: café e\u0301 中文 👩🏽‍💻 with enough text to wrap at a narrow terminal width.`,
  ).join("\n") + "\n\n📎 example.ts\n~~~typescript\nconst ok = true;\n~~~";
  const attachmentMessage: Message = {
    ...message,
    replyTo: "previous-message",
    content: {
      text: "The full body includes the attachment.",
      attachments: [{ type: "snippet", name: "example.ts", content: "const ok = true;" }],
    },
  };
  const replyCommand = 'intercom({ action: "reply", message: "..." })';
  let colorCalls = 0;
  const countingTheme = {
    fg(_name: string, text: string): string {
      colorCalls++;
      return text;
    },
  };
  const component = new InlineMessageComponent(from, attachmentMessage, countingTheme as any, replyCommand, bodyText);
  let firstWideLines: string[] | undefined;

  for (const width of [120, 41, 80, 2, 1, 3, 41, 120]) {
    const lines = component.render(width);
    const callsAfterRender = colorCalls;
    assert.strictEqual(component.render(width), lines, `reuse rendered lines at width ${width}`);
    assert.equal(colorCalls, callsAfterRender, "cached frames do not repeat coloring");
    const fresh = new InlineMessageComponent(from, attachmentMessage, theme as any, replyCommand, bodyText);
    assert.deepEqual(lines, fresh.render(width), `resize matches a fresh render at width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);

    if (width >= 41) {
      const text = lines.slice(1, -1).map((line) => line.slice(1, -1)).join("\n");
      assert.ok(text.replace(/\s/g, "").includes(bodyText.replace(/\s/g, "")), "preserve the entire Unicode body and attachment");
      assert.ok(text.replace(/\s/g, "").includes(`↩ To reply: ${replyCommand}`.replace(/\s/g, "")));
      assert.match(text, /↳ Reply to previous/);
      assert.equal((text.match(/📎 example\.ts/g) ?? []).length, 1);
    }
    if (width === 120) {
      if (firstWideLines) assert.notStrictEqual(lines, firstWideLines, "resizing evicts the previous width");
      firstWideLines = lines;
    }
  }
});

test("inline intercom invalidation refreshes cached theme colors and attachment labels", () => {
  let color = "\x1b[36m";
  const changingTheme = {
    fg(_name: string, text: string): string {
      return `${color}${text}\x1b[39m`;
    },
  };
  const attachmentMessage: Message = {
    ...message,
    content: { text: message.content.text, attachments: [{ type: "file", name: "notes.txt", content: "notes" }] },
  };
  const component = new InlineMessageComponent(from, attachmentMessage, changingTheme as any);
  const before = component.render(80);
  color = "\x1b[35m";
  assert.strictEqual(component.render(80), before, "keep the cached frame until invalidation");

  component.invalidate();
  const after = component.render(80);
  assert.notStrictEqual(after, before);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after.map(stripVTControlCharacters), before.map(stripVTControlCharacters));
  assert.match(after.join("\n"), /📎 notes\.txt/);
  assert.deepEqual(after, new InlineMessageComponent(from, attachmentMessage, changingTheme as any).render(80));
  assert.strictEqual(component.render(80), after, "reuse the refreshed frame");

  component.render(1);
  component.invalidate();
  assert.deepEqual(component.render(80), after, "invalidation also clears a cached narrow frame");
});
