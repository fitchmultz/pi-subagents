import test from "node:test";
import assert from "node:assert/strict";

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
