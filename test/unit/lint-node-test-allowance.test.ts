import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { lintProbes } from "../support/lint-probes.ts";

const probes: Record<string, string> = {
  "allowed-registrations.test.ts": `import { describe as nodeDescribe, it as nodeIt, test as nodeTest } from "node:test";
import assert from "node:assert/strict";

nodeTest("top level registration", () => {
  assert.ok(process.pid > 0);
});

nodeIt("aliased registration", () => {
  assert.ok(process.pid > 0);
});

nodeDescribe("suite body registration", () => {
  nodeTest("inner test registration", () => {
    assert.ok(process.pid > 0);
  });
  nodeIt("inner registration", () => {
    assert.ok(process.pid > 0);
  });
  nodeDescribe("nested suite registration", () => {
    nodeIt("nested registration", () => {
      assert.ok(process.pid > 0);
    });
  });
});
`,
  "context-subtest.test.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

nodeTest("outer", (t) => {
  t.test("unawaited context subtest", () => {
    assert.ok(process.pid > 0);
  });
});
`,
  "local-name.test.ts": `import assert from "node:assert/strict";

function nodeTest(name: string, fn: () => Promise<void>): Promise<void> {
  assert.ok(name.length > 0);
  return fn();
}

nodeTest("unawaited local same-named call", () => Promise.resolve());
`,
  "name-source.test.ts": `export function nodeTest(name: string, fn: () => Promise<void>): Promise<void> {
  if (name.length === 0) {
    throw new Error("empty name");
  }
  return fn();
}
`,
  "imported-name.test.ts": `import { nodeTest } from "./name-source.test.ts";

nodeTest("unawaited imported same-named call", () => Promise.resolve());
`,
  "inside-body.test.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

function work(): Promise<void> {
  return Promise.resolve();
}

nodeTest("body", () => {
  work();
  assert.ok(process.pid > 0);
});
`,
  "unrelated-call.test.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

function unrelated(): Promise<void> {
  return Promise.resolve();
}

unrelated();

nodeTest("registration", () => {
  assert.ok(process.pid > 0);
});
`,
};

// Every control diagnostic is asserted at its exact probe line, so the probe
// sources embed their line positions by construction.
const expectedControls: Record<string, number> = {
  "context-subtest.test.ts": 5,
  "local-name.test.ts": 8,
  "imported-name.test.ts": 3,
  "inside-body.test.ts": 9,
  "unrelated-call.test.ts": 8,
};

nodeTest("node:test registration allowance passes all six qualification controls", (t) => {
  const findings = lintProbes(t, probes);
  if (findings === undefined) {
    return;
  }
  assert.equal(
    findings.some((finding) => finding.file === "allowed-registrations.test.ts"),
    false,
  );
  assert.equal(
    findings.some((finding) => finding.file === "name-source.test.ts"),
    false,
  );
  for (const [file, line] of Object.entries(expectedControls)) {
    assert.deepEqual(
      findings.filter((finding) => finding.file === file),
      [{ file, line, plugin: "typescript", rule: "no-floating-promises" }],
    );
  }
  assert.equal(findings.length, Object.keys(expectedControls).length);
});
