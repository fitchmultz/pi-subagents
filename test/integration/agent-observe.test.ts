import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  Container,
  ProcessTerminal,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import * as sdk from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { record } from "../support/assertions.ts";
import { spy } from "sinon";
import { usageLaunch } from "../support/agent-launch.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import { write } from "../../src/agent/storage.ts";

class CaptureTerminal extends ProcessTerminal {
  output = "";
  input?: (data: string) => void;
  resize?: () => void;
  width = 100;
  height = 32;
  override get columns(): number {
    return this.width;
  }
  override get rows(): number {
    return this.height;
  }
  override start(input: (data: string) => void, resize: () => void): void {
    this.input = input;
    this.resize = resize;
  }
  override stop(): void {
    this.input = undefined;
    this.resize = undefined;
  }
  override write(data: string): void {
    this.output = (this.output + data).slice(-1048576);
  }
  override moveBy(lines: number): void {
    this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
  }
  override hideCursor(): void {
    this.write("\x1b[?25l");
  }
  override showCursor(): void {
    this.write("\x1b[?25h");
  }
  override clearLine(): void {
    this.write("\x1b[K");
  }
  override clearFromCursor(): void {
    this.write("\x1b[J");
  }
  override clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }
  override setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`);
  }
  override setProgress(active: boolean): void {
    this.write(`\x1b]9;4;${active ? 3 : 0}\x07`);
  }
  override async drainInput(): Promise<void> {
    return Promise.resolve();
  }
  send(data: string): void {
    this.input?.(data);
  }
  click(screen: TuiAltScreen, text: string): void {
    const rows = screen.getScreenLines().map(stripTerminalSequences);
    const y = rows.findIndex((row) => row.includes(text));
    assert.ok(y >= 0, `visible mouse target: ${text}\n${rows.join("\n")}`);
    const x = visibleWidth(rows[y].slice(0, rows[y].indexOf(text)));
    this.send(`\x1b[<0;${x + 1};${y + 1}M`);
    this.send(`\x1b[<0;${x + 1};${y + 1}m`);
  }
  text(): string {
    return stripTerminalSequences(this.output);
  }
  clear(): void {
    this.output = "";
  }
}
async function until(check: () => boolean, reason: string, detail?: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `${reason}\n${detail?.() ?? ""}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
function requests(root: string): number {
  return fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").length;
}

function actorExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
function restoreEnvironment(prior: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
async function cleanupActors(root: string): Promise<void> {
  const file = path.join(root, "sessions.jsonl");
  const entries = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  const pids = entries
    .map((line) => record(JSON.parse(line)))
    .filter((entry) => entry.child === true)
    .map((entry) => {
      assert.ok(typeof entry.pid === "number");
      return entry.pid;
    });
  await until(
    () => pids.every(actorExited),
    "actual owned native actors exit after attachment shutdown",
  );
  fs.rmSync(root, { recursive: true, force: true });
}

for (const tuiMode of ["fullscreen", "regular"] as const) {
  test(
    `native ${tuiMode} observer watches an actual child without waking or aborting either agent and clears on replacement`,
    { timeout: 45000 },
    async (t) => {
      const sdkRoot = nativeSdkRoot(process.env.PI_SINGLE_AGENT_TEST_SDK);
      const root = fs.mkdtempSync(path.join(process.env.HOME ?? "", "observer-"));
      const agentDir = path.join(root, "agent");
      fs.mkdirSync(agentDir);
      const prior = {
        PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        OBSERVE_TEST_ROOT: process.env.OBSERVE_TEST_ROOT,
        OBSERVE_TEST_CONTEXT: process.env.OBSERVE_TEST_CONTEXT,
      };
      process.env.PI_PACKAGE_DIR = sdkRoot;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.OBSERVE_TEST_ROOT = root;
      process.env.OBSERVE_TEST_CONTEXT = tuiMode === "regular" ? "fork" : "fresh";
      const providerFile = path.resolve("test/fixtures/agent-observe-provider.ts");
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          extensions: [providerFile],
          quietStartup: true,
          theme: "dark",
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      );
      const models = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const faux = fauxProvider({
        provider: "observe-fixture",
        models: [{ id: "native-observe", reasoning: false }],
      });
      let view: TUI | undefined;
      const services = await sdk.createAgentSessionServices({
        cwd: root,
        agentDir,
        modelRuntime: models,
        settingsManager: sdk.SettingsManager.create(root, agentDir),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: [path.resolve("src/index.ts"), providerFile],
          extensionFactories: [
            (pi) => {
              pi.on("session_start", (_event, ctx) => {
                ctx.ui.setWidget("test-observer-screen", (tui) => {
                  view = tui;
                  return new Container();
                });
              });
            },
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const runtime = await sdk.createAgentSessionRuntime(
        async ({ sessionManager }) => ({
          ...(await sdk.createAgentSessionFromServices({
            services,
            sessionManager,
            model: faux.getModel(),
          })),
          services,
          diagnostics: services.diagnostics,
        }),
        {
          cwd: root,
          agentDir,
          sessionManager: sdk.SessionManager.create(root, path.join(root, "sessions")),
        },
      );
      const terminal = new CaptureTerminal();
      const mode = new sdk.InteractiveMode(runtime, {
        terminal,
        tuiMode,
        initialThemeSetting: "dark",
      });
      const work: { prompt?: Promise<void>; disposed: boolean } = { disposed: false };
      t.after(async () => {
        fs.writeFileSync(path.join(root, "release-child"), "release");
        fs.writeFileSync(path.join(root, "release-parent"), "release");
        try {
          await work.prompt;
        } finally {
          try {
            if (!work.disposed) {
              await runtime.dispose();
            }
          } finally {
            mode.stop();
            restoreEnvironment(prior);
            await cleanupActors(root);
          }
        }
      });
      await mode.init();
      const emptyCommand = mode.getUserInput().then((text) => runtime.session.prompt(text));
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("No child runs"),
        "native command opens empty inventory",
      );
      terminal.send("\x1b");
      await emptyCommand;
      work.prompt = runtime.session.prompt("START_OBSERVE");
      await until(
        () =>
          fs.existsSync(path.join(root, "child-ready")) &&
          fs.existsSync(path.join(root, "parent-ready")),
        "actual provider and child tool are both live",
      );
      await until(
        () => terminal.text().includes("● watch-child 雪 · running"),
        "above-editor widget names the running child without opening /agents",
      );
      const childStart = fs
        .readFileSync(path.join(root, "sessions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line)))
        .find((entry) => entry.child === true);
      assert.ok(childStart !== undefined);
      assert.equal(
        childStart.observerCommand,
        false,
        "human command is not registered in native children",
      );
      const base = path.join(
        agentDir,
        "sessions/agent-runs",
        runtime.session.sessionManager.getSessionId(),
      );
      const runId = fs
        .readdirSync(base)
        .find((name) => fs.existsSync(path.join(base, name, "launch.json")));
      assert.ok(runId !== undefined);
      const runDir = path.join(base, runId);
      if (tuiMode === "fullscreen") {
        assert.ok(view instanceof TuiAltScreen);
        const screen = view;
        const screenLines = () => screen.getScreenLines().map(stripTerminalSequences);
        const click = (text: string) => terminal.click(screen, text);
        const before = requests(root);
        assert.ok(screenLines().some((line) => line.includes("DELEGATE_OUTPUT_START")));
        assert.ok(
          !screenLines().some((line) => line.includes("DELEGATE_OUTPUT_END")),
          "one long logical line stays visually collapsed",
        );
        click("DELEGATE_OUTPUT_START");
        await until(
          () => screenLines().some((line) => line.includes("DELEGATE_OUTPUT_END")),
          "native card click expands the complete tool result",
        );
        click("DELEGATE_OUTPUT_END");
        await until(
          () =>
            screenLines().some((line) => line.includes("DELEGATE_OUTPUT_START")) &&
            !screenLines().some((line) => line.includes("DELEGATE_OUTPUT_END")),
          "native card click collapses the tool result",
        );
        terminal.clear();
        click("● watch-child");
        await until(
          () => screenLines().some((line) => line.includes("CHILD_TEXT_LIVE")),
          "native mouse click opens the child directly while the parent streams",
          () => screenLines().join("\n"),
        );
        assert.equal(requests(root), before, "click-to-watch does not wake either model");
        assert.equal(runtime.session.isStreaming, true, "click-to-watch does not abort the parent");
        click("escape back");
        await until(
          () => screenLines().some((line) => line.includes("enter watch")),
          "mouse Back returns to inventory",
          () => screenLines().join("\n"),
        );
        click(`${runId.slice(0, 8)} running`);
        await until(
          () => screenLines().some((line) => line.includes("CHILD_TEXT_LIVE")),
          "clicking an inventory row opens it",
        );
        terminal.width = 46;
        terminal.resize?.();
        await until(() => visibleWidth(screenLines()[0] ?? "") === 46, "narrow frame is rendered");
        click("escape back");
        await until(
          () => screenLines().some((line) => line.includes("enter watch")),
          "narrow Back returns to inventory",
        );
        click("enter watch");
        await until(
          () => screenLines().some((line) => line.includes("CHILD_TEXT_LIVE")),
          "narrow watch hint opens the child",
        );
        click("escape back");
        await until(
          () => screenLines().some((line) => line.includes("escape close")),
          "close hint becomes visible",
        );
        click("escape close");
        terminal.width = 100;
        terminal.resize?.();
        assert.equal(requests(root), before, "mouse controls do not send or wake a model");
      }
      terminal.clear();
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("watch-child") && terminal.text().includes("enter watch"),
        "native key path lists child while parent streams",
      );
      const calls = requests(root);
      terminal.clear();
      terminal.height = 10;
      terminal.resize?.();
      await until(
        () => terminal.text().includes(`> ${runId.slice(0, 8)}`),
        "selected child stays visible in a ten-row terminal",
      );
      terminal.height = 32;
      terminal.resize?.();
      terminal.clear();
      terminal.send("\r");
      await until(
        () =>
          terminal.text().includes("CHILD_TEXT_LIVE") && terminal.text().includes("observe_gate"),
        "published assistant text and pending native tool call appear",
      );
      if (tuiMode === "regular") {
        assert.match(terminal.text(), /Fork context: includes inherited parent activity/);
      }
      terminal.width = 46;
      terminal.resize?.();
      terminal.clear();
      fs.writeFileSync(path.join(root, "release-child"), "release");
      await until(
        () =>
          terminal.text().includes("CHILD_TOOL_ERROR_FACT") &&
          terminal.text().includes("CHILD_FINAL_FACT"),
        "native journal appends update the same watch",
      );
      assert.equal(
        requests(root),
        calls + 1,
        "only the child's post-tool provider request occurred",
      );
      await until(
        () => fs.existsSync(path.join(runDir, "result.json")),
        "canonical completion is published",
      );
      await until(
        () => terminal.text().includes("Agents: 0 active") && terminal.text().includes("completed"),
        "completed messageable actor is not counted as active work",
      );
      const actor = record(
        JSON.parse(fs.readFileSync(path.join(runDir, "actor.lock/process.json"), "utf8")),
      );
      assert.ok(typeof actor.pid === "number");
      process.kill(actor.pid, 0);
      assert.equal(
        runtime.session.isStreaming,
        true,
        "watch input never aborted the active parent",
      );
      terminal.clear();
      terminal.send("\x1b");
      terminal.width = 100;
      terminal.resize?.();
      await until(
        () => terminal.text().includes("No child runs to show"),
        "completed child disappears from the picker",
      );
      assert.doesNotMatch(terminal.text(), /watch-child 雪 · completed/);
      assert.equal(requests(root), calls + 1, "hiding completed work never wakes a model");
      terminal.send("\x1b");
      terminal.clear();
      terminal.send(`/agents ${runId.slice(0, 8)}`);
      terminal.send("\r");
      terminal.width = 60;
      terminal.resize?.();
      await until(
        () => terminal.text().includes("CHILD_FINAL_FACT"),
        "visible unique eight-character prefix opens the child read-only",
        () => terminal.text(),
      );
      assert.match(
        terminal.text(),
        /\.jsonl/,
        "narrow journal paths retain their useful filename suffix",
      );
      assert.equal(requests(root), calls + 1, "direct watching is also non-waking");
      fs.writeFileSync(path.join(root, "release-parent"), "release");
      await work.prompt;
      await runtime.session.waitForIdle();
      terminal.send("\x1b");
      terminal.send("\x1b");
      terminal.width = 120;
      terminal.height = 60;
      terminal.resize?.();
      if (view instanceof TuiAltScreen) {
        const screen = view;
        const screenLines = () => screen.getScreenLines().map(stripTerminalSequences);
        const before = requests(root);
        const command = mode.getUserInput().then((text) => runtime.session.prompt(text));
        terminal.send("/observer-cards");
        terminal.send("\r");
        await command;
        await until(
          () => screenLines().some((line) => line.includes("intercom_message")),
          "native custom cards have rendered",
        );
        const collapsed = screenLines().join("\n");
        assert.match(collapsed, /agent-completion/);
        assert.match(collapsed, /subagent-notify/);
        assert.match(collapsed, /subagent-human-message/);
        assert.match(collapsed, /CARD_START/);
        assert.doesNotMatch(collapsed, /\*\*CARD_START\*\*/, "collapsed Markdown stays rendered");
        assert.doesNotMatch(collapsed, /CARD_END/, "long custom cards start collapsed");
        terminal.click(screen, "[intercom_message]");
        await until(
          () => screenLines().some((line) => line.includes("CARD_END")),
          "clickable message hint uses native expansion state",
        );
        terminal.send("\x0f");
        await until(
          () =>
            screenLines().some((line) => line.includes("CARD_START")) &&
            !screenLines().some((line) => line.includes("CARD_END")),
          "keyboard and mouse share native expansion state",
        );
        terminal.send("\x0f");
        await until(
          () => screenLines().some((line) => line.includes("CARD_END")),
          "native Ctrl+O expands full card content",
        );
        terminal.send("\x0f");
        await until(
          () =>
            screenLines().some((line) => line.includes("CARD_START")) &&
            !screenLines().some((line) => line.includes("CARD_END")),
          "native Ctrl+O collapses cards again",
        );
        assert.equal(requests(root), before, "card expansion does not wake the model");
        const cards = runtime.session.sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              typeof entry.content === "string" &&
              entry.content.includes("CARD_START"),
          );
        assert.equal(cards.length, 4);
        assert.ok(
          cards.every(
            (entry) =>
              entry.type === "custom_message" &&
              typeof entry.content === "string" &&
              entry.content.endsWith("CARD_END"),
          ),
          "preview truncation never changes the saved model-visible content",
        );
        const shortCommand = mode.getUserInput().then((text) => runtime.session.prompt(text));
        terminal.send("/observer-cards short");
        terminal.send("\r");
        await shortCommand;
        await until(
          () => screenLines().some((line) => line.includes("SHORT_CARD")),
          "short native message has rendered",
        );
        const shortLines = screenLines();
        assert.doesNotMatch(shortLines.join("\n"), /\*\*SHORT_CARD\*\*/);
        const shortHeader = shortLines.findLast((line) => line.includes("[intercom_message]"));
        assert.ok(shortHeader !== undefined);
        assert.doesNotMatch(shortHeader, /to expand|to collapse/, "short cards have no false hint");
      }
      const manager = runtime.session.sessionManager;
      const legacyId = "legacy-observed";
      const legacy = sdk.SessionManager.create(root, path.join(root, "legacy-sessions"));
      legacy.appendMessage(fauxAssistantMessage("LEGACY_PUBLISHED_ACTIVITY"));
      const originalFile = legacy.getSessionFile();
      assert.ok(originalFile !== undefined);
      const original = fs.readFileSync(originalFile, "utf8");
      const inode = fs.statSync(originalFile).ino;
      manager.appendCustomEntry("subagent-run", {
        runId: legacyId,
        ownerSessionId: manager.getSessionId(),
        mode: "single",
        children: [{ index: 0, sessionFile: originalFile }],
      });
      const source = path.join(agentDir, "sessions/subagent-runs", legacyId);
      write(path.join(source, "question-owner.json"), { sessionId: manager.getSessionId() });
      write(path.join(source, "contracts/0.json"), {
        sessionFile: originalFile,
        nativeSessionId: legacy.getSessionId(),
        launch: {
          cwd: root,
          context: "fresh",
          model: "observe-fixture/native-observe",
          thinking: "off",
        },
      });
      const runs = runtime.session.agent.state.tools.find((tool) => tool.name === "agent_runs");
      assert.ok(runs !== undefined);
      const adopted = record(
        (
          await runs.execute("adopt-observed", {
            action: "continue",
            id: legacyId,
            prompt: "Continue the original native child",
            async: false,
          })
        ).details,
      );
      assert.equal(adopted.sessionFile, originalFile);
      assert.equal(adopted.sessionId, legacy.getSessionId());
      assert.ok(typeof adopted.id === "string");
      const commands = path.join(base, adopted.id, "commands");
      const watch = async (id: string, expected: string, opensJournal = true) => {
        const before = requests(root);
        const published = fs.readFileSync(originalFile);
        const queued = fs.readdirSync(commands);
        terminal.clear();
        const command = mode.getUserInput().then((text) => runtime.session.prompt(text));
        terminal.send(`/agents ${id}`);
        terminal.send("\r");
        terminal.width = terminal.width === 120 ? 119 : 120;
        terminal.resize?.();
        await until(
          () => terminal.text().includes(expected),
          `native observer processes ${id}: ${expected}`,
          () => terminal.text(),
        );
        assert.equal(requests(root), before, "observing adopted evidence never wakes a model");
        assert.deepEqual(fs.readFileSync(originalFile), published, "watching is read-only");
        assert.deepEqual(fs.readdirSync(commands), queued, "watching sends no control commands");
        assert.equal(runtime.session.isStreaming, false);
        terminal.send("\x1b");
        if (opensJournal) {
          terminal.send("\x1b");
        }
        await command;
      };
      await watch(adopted.id, "LEGACY_PUBLISHED_ACTIVITY");
      const continued = record(
        (
          await runs.execute("continue-observed", {
            action: "continue",
            id: adopted.id,
            prompt: "Continue the adopted conversation again",
            async: false,
          })
        ).details,
      );
      assert.ok(typeof continued.id === "string");
      assert.notEqual(continued.id, adopted.id);
      assert.equal(continued.rootId, adopted.id);
      assert.equal(continued.sessionFile, originalFile);
      assert.equal(continued.sessionId, legacy.getSessionId());
      await watch(continued.id, "LEGACY_PUBLISHED_ACTIVITY");
      assert.ok(fs.readFileSync(originalFile, "utf8").startsWith(original));
      assert.equal(
        fs.statSync(originalFile).ino,
        inode,
        "adoption/continuation retain the journal",
      );
      for (const id of [adopted.id, continued.id]) {
        assert.deepEqual(
          fs.readdirSync(path.join(base, id)).filter((file) => file.endsWith(".jsonl")),
          [],
          "neither adoption nor later continuation copies the native evidence",
        );
      }
      const savedLaunch = record(
        JSON.parse(fs.readFileSync(path.join(base, adopted.id, "launch.json"), "utf8")),
      );
      write(path.join(base, "foreign-owner/launch.json"), {
        ...savedLaunch,
        id: "foreign-owner",
        owner: "another-native-parent",
      });
      await watch("foreign-owner", "Saved child metadata is unavailable", false);
      fs.rmSync(path.join(base, "foreign-owner"), { recursive: true });
      write(path.join(base, "unadopted-path/launch.json"), {
        ...savedLaunch,
        id: "unadopted-path",
        rootId: "unadopted-path",
      });
      await watch("unadopted-path", "Child journal path is outside", false);
      const foreign = sdk.SessionManager.create(root, path.join(root, "foreign-sessions"));
      foreign.appendMessage(fauxAssistantMessage("FOREIGN_NATIVE_ACTIVITY"));
      const foreignFile = foreign.getSessionFile();
      assert.ok(foreignFile !== undefined);
      write(path.join(base, "changed-adopted-path/launch.json"), {
        ...savedLaunch,
        id: "changed-adopted-path",
        sessionFile: foreignFile,
      });
      await watch("changed-adopted-path", "Child journal path is outside", false);
      fs.renameSync(originalFile, originalFile + ".held");
      fs.symlinkSync(originalFile + ".held", originalFile);
      await watch(continued.id, "ELOOP");
      assert.doesNotMatch(terminal.text(), /LEGACY_PUBLISHED_ACTIVITY|FOREIGN_NATIVE_ACTIVITY/);
      fs.unlinkSync(originalFile);
      fs.copyFileSync(foreignFile, originalFile);
      await watch(continued.id, "Native journal identity does not match this child");
      assert.doesNotMatch(terminal.text(), /LEGACY_PUBLISHED_ACTIVITY|FOREIGN_NATIVE_ACTIVITY/);
      fs.unlinkSync(originalFile);
      fs.renameSync(originalFile + ".held", originalFile);
      terminal.clear();
      const replacement = await runtime.newSession();
      assert.equal(replacement.cancelled, false);
      const newCommand = mode.getUserInput().then((text) => runtime.session.prompt(text));
      terminal.clear();
      terminal.send("/agents");
      terminal.send("\r");
      await until(
        () => terminal.text().includes("No child runs"),
        "replacement cannot mix previous owner's children",
      );
      assert.equal(runtime.session.isStreaming, false);
      await runtime.dispose();
      work.disposed = true;
      mode.stop();
      await newCommand;
      assert.equal(terminal.input, undefined, "native terminal transport is stopped");
    },
  );
}

test(
  "native observer caches completed metadata, probes each active root once per tick and resolves ambiguity beyond its row cache",
  { timeout: 30000 },
  async (t) => {
    const sdkRoot = nativeSdkRoot(process.env.PI_SINGLE_AGENT_TEST_SDK);
    const root = fs.mkdtempSync(path.join(process.env.HOME ?? "", "observer-cache-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    const prior = {
      PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.PI_PACKAGE_DIR = sdkRoot;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const manager = sdk.SessionManager.create(root, path.join(root, "sessions"));
    const owner = manager.getSessionId();
    const base = path.join(agentDir, "sessions/agent-runs", owner);
    const identity = { ...ownIdentity(), token: "native-observer-fixture" };
    const publish = (id: string, complete: boolean) => {
      const dir = path.join(base, id);
      fs.mkdirSync(dir, { recursive: true });
      const native = sdk.SessionManager.create(root, dir);
      const file = native.getSessionFile();
      assert.ok(file !== undefined);
      fs.writeFileSync(file, JSON.stringify(native.getHeader()) + "\n");
      const launch = {
        ...usageLaunch(file),
        id,
        rootId: id,
        owner,
        sessionId: native.getSessionId(),
        prompt: "large task ".repeat(15000),
      };
      write(path.join(dir, "launch.json"), launch);
      write(path.join(dir, "actor.lock/process.json"), identity);
      write(path.join(dir, "commands/guidance.json"), {
        id: "guidance",
        runId: id,
        action: "steer",
        prompt: "large guidance ".repeat(15000),
        createdAt: 1,
      });
      fs.writeFileSync(path.join(dir, "output.txt"), "PRIVATE_OUTPUT".repeat(10000));
      if (complete) {
        write(path.join(dir, "result.json"), { id, owner, status: "completed", endedAt: 1 });
      }
      return launch;
    };
    for (let i = 0; i < 122; i++) {
      publish(`completed-${i}`, true);
    }
    // Use the observed filesystem order, not an assumption about sorted readdir.
    const ids = fs.readdirSync(base);
    const firstId = ids.at(-2);
    const secondId = ids.at(-1);
    assert.ok(firstId !== undefined && secondId !== undefined);
    const completedIds = new Set(ids.slice(0, -2));
    const active = { ...publish(firstId, false), name: "active-first" };
    fs.rmSync(path.join(base, firstId, "result.json"));
    fs.rmSync(path.join(base, secondId, "result.json"));
    write(path.join(base, firstId, "launch.json"), active);
    write(path.join(base, secondId, "launch.json"), {
      ...active,
      id: secondId,
      name: "active-second",
      rootId: firstId,
      predecessor: firstId,
    });
    const models = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "observe-fixture", models: [{ id: "native-observe" }] });
    models.registerNativeProvider(faux.provider);
    const services = await sdk.createAgentSessionServices({
      cwd: root,
      agentDir,
      modelRuntime: models,
      settingsManager: sdk.SettingsManager.inMemory({ quietStartup: true, theme: "dark" }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noThemes: true,
        noPromptTemplates: true,
        additionalExtensionPaths: [path.resolve("src/agent/observe.ts")],
      },
    });
    const runtime = await sdk.createAgentSessionRuntime(
      async ({ sessionManager }) => ({
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          model: faux.getModel(),
        })),
        services,
        diagnostics: services.diagnostics,
      }),
      { cwd: root, agentDir, sessionManager: manager },
    );
    const terminal = new CaptureTerminal();
    const mode = new sdk.InteractiveMode(runtime, {
      terminal,
      tuiMode: "fullscreen",
      initialThemeSetting: "dark",
    });
    const opens = spy(fs, "openSync");
    const probes = spy(cp, "execFileSync");
    const scans = spy(fs, "readdirSync");
    syncBuiltinESMExports();
    const opened = () =>
      opens.getCalls().flatMap((call) => {
        const args: readonly unknown[] = call.args;
        return typeof args[0] === "string" ? [args[0]] : [];
      });
    const identityProbes = () =>
      process.platform === "linux"
        ? opened().filter((file) => file === `/proc/${process.pid}`).length
        : probes.getCalls().filter((call) => {
            const args: readonly unknown[] = call.args;
            return args[0] === "ps";
          }).length;
    const scanned = () =>
      scans.getCalls().some((call) => {
        const args: readonly unknown[] = call.args;
        return args[0] === base;
      });
    t.after(async () => {
      try {
        await runtime.dispose();
      } finally {
        mode.stop();
        opens.restore();
        probes.restore();
        scans.restore();
        syncBuiltinESMExports();
        restoreEnvironment(prior);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await mode.init();
    await until(
      () => terminal.text().includes("Agents: 0+ active (checking…) · 122 runs"),
      "incomplete native inventory qualifies the active count naturally",
    );
    terminal.clear();
    const loading = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents");
    terminal.send("\r");
    await until(
      () =>
        terminal.text().includes("Agents · read-only") && terminal.text().includes("(checking…)"),
      "picker is rendered before the final metadata batch",
    );
    assert.match(terminal.text(), /Checking saved child runs…/);
    assert.doesNotMatch(terminal.text(), /No child runs to show/);
    await until(
      () => terminal.text().includes("Agents: 2 active · 122 runs"),
      "initial owner metadata scan has completed",
    );
    assert.doesNotMatch(terminal.text(), /completed-\d/, "completed rows stay out of the widget");
    terminal.send("\x1b");
    await loading;
    assert.equal(opened().filter((file) => file.endsWith("/launch.json")).length, 122);
    assert.ok(
      identityProbes() >= 1 && identityProbes() <= 2,
      "cold inventory spans two ticks; only the active root is probed in either batch",
    );
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "next actual metadata scan processed the owner inventory");
    const reads = opened();
    assert.ok(
      reads.includes(path.join(base, secondId, "result.json")),
      "completed history never consumes the warm active refresh budget",
    );
    assert.equal(
      reads.filter((file) => file.endsWith("/launch.json")).length,
      0,
      "immutable launch prompts are not re-read",
    );
    assert.equal(
      reads.filter((file) => completedIds.has(path.relative(base, file).split(path.sep)[0])).length,
      0,
      "completed metadata and idle actors are cached",
    );
    assert.equal(
      reads.filter((file) => file.includes("/commands/") || file.endsWith("/output.txt")).length,
      0,
      "inventory never reads guidance prompts or output",
    );
    assert.equal(identityProbes(), 1, "one actual PID/birth owner lookup per active root per tick");
    write(path.join(base, firstId, "successor.json"), { id: secondId });
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "owner processes the published A-to-B successor on the next scan");
    assert.ok(opened().includes(path.join(base, firstId, "successor.json")));
    assert.equal(
      identityProbes(),
      1,
      "only successor B probes its shared live actor; superseded A does not",
    );
    await until(
      () => terminal.text().includes("Agents: 1 active · 122 runs"),
      "missing-result predecessor no longer inherits the successor's liveness",
    );
    assert.match(terminal.text(), /○ active-first · interrupted/);
    write(path.join(base, secondId, "result.json"), {
      id: secondId,
      owner,
      status: "completed",
      endedAt: 1,
    });
    opens.resetHistory();
    probes.resetHistory();
    scans.resetHistory();
    await until(scanned, "owner processes B's canonical completion on the next scan");
    assert.ok(
      opened().includes(path.join(base, secondId, "result.json")),
      "warm B refresh is not delayed behind 120 completed histories",
    );
    assert.equal(
      opened().filter((file) => file.startsWith(path.join(base, firstId) + path.sep)).length,
      0,
      "immutable superseded A remains cached even without a result",
    );
    assert.equal(
      identityProbes(),
      0,
      "B's live idle actor is not probed after canonical completion",
    );
    await until(
      () => terminal.text().includes("Agents: 0 active · 122 runs"),
      "completed successor cannot make interrupted predecessor look active",
    );
    terminal.clear();
    const retired = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents");
    terminal.send("\r");
    await until(
      () => terminal.text().includes("interrupted · active-first"),
      "native inventory keeps the interrupted predecessor visible",
    );
    assert.doesNotMatch(terminal.text(), /completed · active-second/);
    terminal.send("\x1b");
    await retired;
    for (let i = 0; i < 101; i++) {
      publish(`padding-${String(i).padStart(3, "0")}`, true);
    }
    publish("zzprefix-first", true);
    publish("zzprefix-second", true);
    opens.resetHistory();
    terminal.clear();
    const ambiguous = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents zzprefix");
    terminal.send("\r");
    await until(
      () => terminal.text().includes("Ambiguous child run prefix"),
      "all canonical IDs, not just the first 50 cached rows, participate in prefix resolution",
    );
    assert.equal(
      opened().filter((file) => file.includes("/zzprefix-")).length,
      0,
      "ambiguity is rejected while both matching rows remain outside the metadata cache",
    );
    terminal.send("\x1b");
    await ambiguous;
    terminal.clear();
    const missing = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents missing-run");
    terminal.send("\r");
    await until(
      () => terminal.text().includes("No child run matches that ID"),
      "missing ID has observer-specific, non-launch wording",
    );
    terminal.send("\x1b");
    await missing;
  },
);
