import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { observeReads } from "../support/runtime-fs.ts";
import { record, textAt as firstText } from "../support/assertions.ts";
import { JournalFrames, readJsonProjection, scanJournal } from "../../src/shared/journal-frames.ts";
import { JsonProjection } from "../../src/shared/json-projection.ts";
import { NativeJournal } from "../../src/shared/native-journal.ts";
import { readOutputPage } from "../../src/shared/output-page.ts";
import { childUsage, sumUsage } from "../../src/agent/usage.ts";
import { usageLaunch as launch } from "../support/agent-launch.ts";

function baseline(file: string): Set<string> {
  const ids = new Set<string>();
  scanJournal(
    file,
    (keys) => keys.length === 0 || keys[0] === "id",
    ({ value }) => {
      assert.equal(typeof value.id, "string");
      if (typeof value.id === "string") {
        ids.add(value.id);
      }
    },
    { policy: "strict", requireNewline: true },
  );
  return ids;
}

const usage = {
  input: 3,
  output: 5,
  cacheRead: 7,
  cacheWrite: 11,
  totalTokens: 26,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 7, total: 13 },
};
function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-subagents-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("JSONL cursors commit complete validated records across one-byte Unicode chunks and keep torn tails", () => {
  const values: unknown[] = [],
    frames = new JournalFrames(
      () => true,
      ({ value }) => {
        values.push(value);
      },
      { policy: "live" },
    );
  const complete = Buffer.from('{"id":"🦄","ignored":{"text":"\\uD83E\\uDD84"}}\r\n');
  for (const byte of complete) {
    frames.write(Buffer.from([byte]));
  }
  frames.write(Buffer.from('{"id":"later"'));
  assert.equal(frames.finish(), complete.length);
  assert.deepEqual(values, [{ id: "🦄", ignored: { text: "🦄" } }]);
  frames.write(Buffer.from("}\n"));
  assert.equal(frames.finish(), complete.length + Buffer.byteLength('{"id":"later"}\n'));
  assert.deepEqual(values[1], { id: "later" });
  const skipped = new JournalFrames(
    (keys) => keys.length === 0 || keys[0] === "id",
    () => assert.fail("malformed skipped data cannot commit"),
  );
  skipped.write(Buffer.from('{"id":"x","ignored":{"bad":truX}}'));
  assert.throws(() => skipped.finish(), SyntaxError);
  const projection = new JsonProjection((keys) => {
    if (keys.length === 0) {
      return true;
    }
    return keys[0] === "text" ? 3 : Number.NaN;
  });
  projection.write('{"skip":{"x":"ignored"},"text":"abcdef","number":1234}');
  assert.deepEqual(projection.finish(), { text: "abc" });
});

test("sealed inspection accepts a valid unterminated record without repair; strict accounting rejects malformed required records", (t) => {
  const root = temporary(t),
    file = path.join(root, "native.jsonl");
  const ownerFile = path.join(root, "owner.json");
  fs.writeFileSync(ownerFile, "{}");
  const failure = new Error("original projection failure");
  failure.toString = () => {
    throw new Error("broken error stringifier");
  };
  assert.throws(
    () =>
      readJsonProjection(ownerFile, () => {
        throw failure;
      }),
    (error: unknown) => {
      assert.ok(error instanceof SyntaxError);
      assert.equal(error.cause, failure);
      assert.match(error.message, /original projection failure/);
      return true;
    },
  );
  const original =
    '{"type":"session","id":"child","version":3}\n{"type":"model_change","id":"m","parentId":null,"provider":"p","modelId":"m"}';
  fs.writeFileSync(file, original);
  let bytesRead = 0;
  observeReads(t, ({ count }) => {
    bytesRead += count;
  });
  assert.equal(new NativeJournal(file).configuration().model, "p/m");
  assert.equal(
    bytesRead,
    Buffer.byteLength(original),
    "plain inspection does not pay for opt-in history prefix hashing",
  );
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(new NativeJournal(file, "live").records.length, 1);
  fs.appendFileSync(file, '\n{"type":"custom","id":"broken","data":[1,]}\n');
  assert.throws(() => childUsage(launch(file), new Set()), SyntaxError);
});

test("sealed inspection and LF-published native bodies never weaken strict accounting or inherited baselines", (t) => {
  const file = path.join(temporary(t), "native.jsonl"),
    text = "Complete selected body ".repeat(400) + "FULL-END";
  const original =
    '{"type":"session","id":"child","version":3}\nnot JSON\n' +
    JSON.stringify({
      type: "message",
      id: "terminal",
      parentId: null,
      message: {
        role: "assistant",
        provider: "fixture",
        model: "faux",
        timestamp: 7,
        stopReason: "stop",
        usage,
        content: [{ type: "text", text }],
      },
    });
  fs.writeFileSync(file, original);
  const sealed = new NativeJournal(file),
    unpublished = new NativeJournal(file, "inspect", true);
  const sealedTerminal = sealed.byId.get("terminal");
  assert.ok(sealedTerminal);
  assert.equal(firstText(record(sealed.body(sealedTerminal).message).content), text);
  assert.equal(unpublished.byId.has("terminal"), false);
  assert.equal(unpublished.configuration().model, undefined);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.appendFileSync(file, "\n");
  const published = new NativeJournal(file, "inspect", true);
  assert.equal(published.configuration().model, "fixture/faux");
  const publishedTerminal = published.byId.get("terminal");
  assert.ok(publishedTerminal);
  assert.equal(firstText(record(published.body(publishedTerminal).message).content), text);
  assert.throws(
    () => childUsage(launch(file), new Set()),
    SyntaxError,
    "inspection tolerance cannot weaken required accounting",
  );
  fs.writeFileSync(file, original.replace("not JSON\n", ""));
  assert.throws(
    () => baseline(file),
    SyntaxError,
    "an unpublished entry cannot become an inherited attempt baseline",
  );
  assert.throws(() => childUsage(launch(file), new Set(), "terminal"), /not LF-published/);
  fs.appendFileSync(file, "\n");
  assert.deepEqual([...baseline(file)], ["child", "terminal"]);
  const terminalUsage = childUsage(launch(file), new Set(), "terminal");
  assert.equal(sumUsage(terminalUsage).input, 3);
});

test("strict/live JSONL reject non-object roots and invalid UTF-8 inside skipped payloads without committing their cursors", () => {
  const invalid = Buffer.concat([
    Buffer.from('{"ignored":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}\n'),
  ]);
  for (const policy of ["strict", "live"] as const) {
    for (const bytes of [
      invalid,
      Buffer.from("[]\n"),
      Buffer.from("null\n"),
      Buffer.from('"scalar"\n'),
    ]) {
      const records: unknown[] = [],
        reader = new JournalFrames(
          (keys) => keys.length === 0,
          ({ value }) => {
            records.push(value);
          },
          { policy },
        );
      reader.write(Buffer.from('{"id":"committed"}\n'));
      assert.throws(() => reader.write(bytes), SyntaxError);
      assert.deepEqual(records, [{}], "only the prior selected object was committed");
    }
  }
});

test("output pages preserve Unicode at byte boundaries and do not read the preceding output", (t) => {
  const file = path.join(temporary(t), "output");
  fs.writeFileSync(file, "prefix\n🦄日本語\nend");
  const reads: Array<{ length: number; position: number | bigint | null }> = [];
  observeReads(t, ({ length, position }) => {
    reads.push({ length, position });
  });
  const first = readOutputPage(file, { offset: 7, length: 5 });
  assert.equal(first.text, "🦄");
  const next = readOutputPage(file, { offset: first.nextOffset, length: 9 });
  assert.equal(next.text, "日本語");
  assert.equal(readOutputPage(file, { length: 4 }).text, "\nend");
  assert.deepEqual(
    reads,
    [
      { length: 5, position: 7 },
      { length: 9, position: 11 },
      { length: 4, position: 20 },
    ],
    "each page reads only its requested byte range, never the prefix",
  );
});

test(
  "a valid ignored individual value larger than Node's string ceiling preserves billing, configuration, baselines and source bytes under a 96 MiB heap",
  { timeout: 180_000 },
  (t) => {
    const root = temporary(t),
      file = path.join(root, "native.jsonl"),
      fd = fs.openSync(file, "wx"),
      hash = createHash("sha256");
    const write = (value: string | Buffer) => {
      if (typeof value === "string") {
        fs.writeSync(fd, value);
      } else {
        fs.writeSync(fd, value);
      }
      hash.update(value);
    };
    const timestamp = "2026-01-01T00:00:00Z";
    write(
      JSON.stringify({ type: "session", version: 3, id: "child", cwd: root, timestamp }) + "\n",
    );
    write(
      JSON.stringify({
        type: "message",
        id: "inherited",
        parentId: null,
        timestamp,
        message: { role: "assistant", provider: "p", model: "old", content: [], usage },
      }) + "\n",
    );
    write('{"type":"custom","id":"noise","parentId":"inherited","data":{"ignored":"');
    const block = Buffer.alloc(64 * 1024, 120);
    for (let index = 0; index < 8193; index++) {
      write(block);
    }
    write('"}}\n');
    for (const [id, parentId, role] of [
      ["paid", "noise", "assistant"],
      ["abandoned", "inherited", "toolResult"],
      ["terminal", "paid", "assistant"],
    ]) {
      write(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp,
          message: {
            role,
            provider: "p",
            model: "selected",
            responseModel: "actual",
            toolCallId: "tool",
            toolName: "child",
            isError: false,
            usage,
            content: [{ type: "text", text: id === "terminal" ? "Final 🦄 answer" : id }],
          },
        }) + "\n",
      );
    }
    write(
      JSON.stringify({
        type: "custom_message",
        id: "completion",
        parentId: "terminal",
        customType: "agent-completion",
        details: { owner: "child", id: "run", completed: true },
      }) + "\n",
    );
    fs.closeSync(fd);
    const checksum = hash.digest("hex");
    const nativeModule = new URL("../../src/agent/usage.ts", import.meta.url).href;
    const journalModule = new URL("../../src/shared/native-journal.ts", import.meta.url).href;
    const framesModule = new URL("../../src/shared/journal-frames.ts", import.meta.url).href;
    const receiptModule = new URL("../../src/agent/receipts.ts", import.meta.url).href;
    const check = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `
		import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; import {createReadStream} from 'node:fs';
		import {childUsage,sumUsage} from ${JSON.stringify(nativeModule)};
		import {receiptId} from ${JSON.stringify(receiptModule)};
		import {NativeJournal} from ${JSON.stringify(journalModule)};
		import {scanJournal} from ${JSON.stringify(framesModule)};
		const file=process.argv[1]; const launch=${JSON.stringify(launch(file))};
		const ids=[];
		scanJournal(file, keys=>keys.length===0||keys[0]==='id', ({value})=>ids.push(value.id), {policy:'strict',requireNewline:true});
		assert.deepEqual(ids,['child','inherited','noise','paid','abandoned','terminal','completion']);
		const contributions=childUsage(launch,new Set(['child','inherited']),'terminal');
		const total=sumUsage(contributions);
		assert.deepEqual([total.input,total.output,total.cost.total],[9,15,39]);
		assert.deepEqual(contributions.map(c=>c.id),['child:paid','child:abandoned','child:terminal']);
		assert.deepEqual(contributions.map(c=>[c.provider,c.model]),[['p','actual'],['p','selected'],['p','actual']]);
		const journal=new NativeJournal(file);
		assert.equal(journal.configuration().model,'p/selected');
		assert.equal(journal.body(journal.byId.get('terminal')).message.content[0].text,'Final 🦄 answer');
		assert.equal(receiptId(file,'child',entry=>entry.customType==='agent-completion'&&entry.details?.owner==='child'&&entry.details?.completed===true),'completion');
		const hash=createHash('sha256'); for await(const bytes of createReadStream(file)) hash.update(bytes);
		assert.equal(hash.digest('hex'),process.argv[2]); console.log('bounded native storage: exact counters/IDs/configuration/body, source unchanged, heap limit 96 MiB');
	`,
        file,
        checksum,
        root,
      ],
      {
        encoding: "utf8",
        timeout: 170_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=96" },
      },
    );
    assert.equal(check.status, 0, check.stderr);
    t.diagnostic(check.stdout.trim());
    // A successor may append paid work to the same journal. The predecessor's
    // physical terminal entry, rather than a wall-clock cutoff, stays authoritative.
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "usage",
        id: "successor",
        parentId: "terminal",
        usage,
        provider: "later",
        model: "later",
      }) + "\nnot JSON\n",
    );
    const predecessor = childUsage(launch(file), new Set(["child", "inherited"]), "terminal");
    assert.equal(sumUsage(predecessor).input, 9);
    assert.throws(() => childUsage(launch(file), new Set()), SyntaxError);
  },
);
