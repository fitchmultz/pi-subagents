import { createSubagentState } from "../support/background-fixtures.ts";
import { textAt } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  type MockPi,
  createEventBus,
  createNativeSessionFixture,
  makeMinimalCtx,
  makeAgent,
  createMockPi,
  createTempDir,
  removeTempDir,
  events,
} from "../support/helpers.ts";

const nativeRoot = createTempDir("payload-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});

function makeState(cwd: string) {
  return createSubagentState(cwd);
}

function makeExecutor(cwd: string) {
  return createSubagentExecutor({
    pi: {
      ...native.pi,
      events: createEventBus(),
    },
    state: makeState(cwd),
    config: {},
    asyncByDefault: false,
    tempArtifactsDir: cwd,
    getSubagentSessionRoot: () => cwd,
    expandTilde: (value: string) => value,
    discoverAgents: () => ({
      agents: [makeAgent("tester", { description: "Tool-heavy test agent" })],
    }),
  });
}

function buildDockerNoiseChunk(step: number): string {
  const lines = [
    `[docker] step ${step}: loading build definition from Dockerfile.test`,
    `[docker] step ${step}: resolving image config for ghcr.io/example/service:${String(step % 7)}`,
    `[docker] step ${step}: copying layer sha256:${String(step).padStart(4, "0")}${"ab".repeat(24)}`,
    `[docker] step ${step}: running npm test -- --runInBand --reporter=dot`,
    `[docker] step ${step}: warning: retrying flaky network fetch for registry metadata`,
    `[docker] step ${step}: error: service container exited unexpectedly with code ${(step % 3) + 1}`,
    `[docker] step ${step}: stack: ${"Trace line with nested module resolution and container stdout noise ".repeat(8)}`,
    `[docker] step ${step}: stderr: ${"Build output and diagnostics ".repeat(16)}`,
  ];
  return lines.join("\n");
}

describe("foreground result payload compaction", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-payload-test-");
    mockPi.reset();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("keeps foreground single-run payloads compact after tool-heavy runs", async () => {
    const jsonl: unknown[] = [];
    jsonl.push({
      type: "message_end",
      message: {
        ...events.assistantMessage("").message,
        content: [
          {
            type: "toolCall",
            id: "mock-write",
            name: "write",
            arguments: {
              path: "/tmp/huge-report.md",
              content: "x".repeat(50_000),
            },
          },
        ],
      },
    });
    jsonl.push(
      events.toolStart("write", { path: "/tmp/huge-report.md", content: "x".repeat(50_000) }),
    );
    jsonl.push(events.toolResult("write", "ok"));
    jsonl.push(events.toolEnd("write"));
    for (let step = 0; step < 60; step++) {
      jsonl.push(
        events.toolStart(
          "bash",
          {
            command: `docker compose run --rm api test-shard-${step} --retry --verbose`,
          },
          `bash-${step}`,
        ),
      );
      jsonl.push(events.toolResult("bash", buildDockerNoiseChunk(step), false, `bash-${step}`));
      jsonl.push(events.toolEnd("bash", `bash-${step}`));
    }
    jsonl.push(
      events.assistantMessage(
        "Finished the test sweep. Three failures reproduced, two were flaky, and the smallest fix is to retry the image bootstrap before the integration shard starts.",
      ),
    );
    mockPi.onCall({ jsonl });

    const executor = makeExecutor(tempDir);
    const result = await executor.execute({
      toolCallId: "id",
      params: { agent: "tester", task: "Run the full noisy test sweep", includeProgress: false },
      signal: new AbortController().signal,
      ctx: makeMinimalCtx(tempDir),
    });

    assert.equal(
      result.isError,
      undefined,
      result.isError === true
        ? JSON.stringify({
            content: result.content,
            runId: result.details.runId,
            wait: result.details.wait,
          })
        : undefined,
    );
    assert.equal(result.details.mode, "single");
    assert.equal(result.details.results.length, 1);

    const displayText = textAt(result.content);
    assert.ok(
      displayText.length < 2_000,
      `expected small visible output, got ${displayText.length} bytes`,
    );

    const step = result.details.results[0];
    assert.equal(step.exitCode, 0);
    assert.ok(
      step.messages === undefined,
      "completed foreground results should not inline raw messages",
    );
    assert.ok(
      step.progress === undefined,
      "completed foreground results should not inline full progress objects",
    );
    assert.ok(
      Boolean(step.toolCalls?.length),
      "completed foreground results should preserve compact tool-call summaries",
    );
    assert.equal(step.toolCalls?.[0].text, "write /tmp/huge-report.md");
    assert.equal(step.toolCalls[0].expandedText, "write /tmp/huge-report.md");

    const payloadSize = JSON.stringify(result).length;
    assert.ok(
      payloadSize < 80_000,
      `expected compact foreground payload, got ${payloadSize} bytes`,
    );
  });
});
