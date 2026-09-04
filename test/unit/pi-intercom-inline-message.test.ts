import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
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
