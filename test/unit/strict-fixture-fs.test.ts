import assert from "node:assert/strict";
import fs, { type PathLike, type ReadPosition } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test as nodeTest } from "node:test";
import { traceReadSync, traceReaddirSync } from "../support/strict-fixture-fs.ts";

nodeTest("filesystem observations preserve native encodings, Dirents and read signatures", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "strict-fixture-fs-"));
  const file = join(root, "é.txt");
  const scans: PathLike[] = [];
  const reads: { fd: number; count: number; position: ReadPosition | null | undefined }[] = [];
  try {
    fs.writeFileSync(file, "abcdef");
    traceReaddirSync((directory) => {
      scans.push(directory);
    });
    traceReadSync((fd, count, position) => {
      reads.push({ fd, count, position });
    });

    assert.deepEqual(fs.readdirSync(root), ["é.txt"]);
    assert.deepEqual(fs.readdirSync(root, "hex"), ["c3a92e747874"]);
    assert.deepEqual(
      fs.readdirSync(root, { encoding: "utf8", withFileTypes: false, recursive: undefined }),
      ["é.txt"],
    );
    const encodedName = Buffer.from([0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74]);
    assert.deepEqual(fs.readdirSync(root, "buffer"), [encodedName]);
    assert.deepEqual(fs.readdirSync(root, { encoding: "buffer" }), [encodedName]);
    assert.deepEqual(fs.readdirSync(root, { encoding: "buffer", withFileTypes: false }), [
      encodedName,
    ]);

    const textEntries = fs.readdirSync(root, { withFileTypes: true });
    assert.equal(textEntries.length, 1);
    const [textEntry] = textEntries;
    assert.ok(textEntry instanceof fs.Dirent);
    assert.equal(textEntry.name, "é.txt");
    assert.equal(textEntry.isFile(), true);
    assert.equal(textEntry.isDirectory(), false);

    const bufferEntries = fs.readdirSync(root, { encoding: "buffer", withFileTypes: true });
    assert.equal(bufferEntries.length, 1);
    const [bufferEntry] = bufferEntries;
    assert.ok(bufferEntry instanceof fs.Dirent);
    assert.deepEqual(bufferEntry.name, encodedName);
    assert.equal(bufferEntry.isFile(), true);
    assert.equal(bufferEntry.isDirectory(), false);
    assert.deepEqual(
      scans,
      Array.from({ length: 8 }, () => root),
    );

    const fd = fs.openSync(file, "r");
    try {
      const positional = Buffer.alloc(4);
      assert.equal(fs.readSync(fd, positional, 1, 2, 1), 2);
      assert.deepEqual(positional, Buffer.from([0, 0x62, 0x63, 0]));

      const options = Buffer.alloc(4);
      assert.equal(fs.readSync(fd, options, { offset: 0, length: 3, position: 3 }), 3);
      assert.deepEqual(options, Buffer.from([0x64, 0x65, 0x66, 0]));

      const defaults = Buffer.alloc(4);
      assert.equal(fs.readSync(fd, defaults), 4);
      assert.deepEqual(defaults, Buffer.from([0x61, 0x62, 0x63, 0x64]));
      assert.deepEqual(reads, [
        { fd, count: 2, position: 1 },
        { fd, count: 3, position: 3 },
        { fd, count: 4, position: undefined },
      ]);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
