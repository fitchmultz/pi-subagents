import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, findPackageJSON, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type * as MarkedModule from "marked";
import {
  Container,
  ProcessTerminal,
  stripTerminalSequences,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import * as sdk from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { nativeSdkRoot } from "../support/native-sdk.ts";
import { assertDefined, record } from "../support/assertions.ts";
import { spy } from "sinon";
import { usageLaunch } from "../support/agent-launch.ts";
import { ownIdentity } from "../../src/agent/process.ts";
import { write } from "../../src/agent/storage.ts";
import type { ObserverTranscript } from "../../src/agent/observe-transcript.ts";
import type { ObservationClient } from "../../src/agent/observe-client.ts";

function components(component: Component): Component[] {
  return [
    component,
    ...(component instanceof Container ? component.children.flatMap(components) : []),
  ];
}

function observesNativeProgress(component: Component): component is ObserverTranscript {
  return (
    component instanceof Container &&
    "observe" in component &&
    typeof component.observe === "function"
  );
}

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
async function until(
  check: () => boolean,
  reason: string,
  detail?: () => string,
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, `${reason}\n${detail?.() ?? ""}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
function requests(root: string): number {
  return fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").length;
}

/** Counts the selected host's Markdown parses, the expensive native work behind each render. */
async function markdownParses(sdkRoot: string) {
  const tui = findPackageJSON("@earendil-works/pi-tui", path.join(sdkRoot, "dist/index.js"));
  assertDefined(tui);
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const { Marked }: typeof MarkedModule = await import(
    pathToFileURL(createRequire(tui).resolve("marked")).href
  );
  const lexer = spy(Marked.prototype, "lexer");
  const count = (marker: string) =>
    lexer.getCalls().filter((call) => call.args[0].includes(marker)).length;
  // The host's own streaming component decides whether an unchanged run keeps its parse.
  const probe = new sdk.AssistantMessageComponent(undefined, false);
  for (const text of ["PROBE_ANSWER", "PROBE_ANSWER grows"]) {
    probe.updateContent(
      fauxAssistantMessage([
        { type: "thinking", thinking: "PROBE_THINKING" },
        { type: "text", text },
      ]),
      true,
    );
    probe.render(46);
  }
  const reused = count("PROBE_THINKING") === 1;
  return {
    lexer,
    count,
    assertReused(parses: number) {
      if (reused) {
        assert.equal(
          parses,
          1,
          "answer updates reuse the unchanged native thinking parse, as native Pi streaming does",
        );
      }
    },
  };
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

async function firstPageNavigation(
  terminal: CaptureTerminal,
  view: TUI | undefined,
  fork: boolean,
): Promise<void> {
  const visible = () =>
    view instanceof TuiAltScreen
      ? view.getScreenLines().map(stripTerminalSequences).join("\n")
      : terminal.text();
  terminal.clear();
  terminal.send("\x10");
  await until(
    () => visible().includes("Assignment preview"),
    "Details is keyboard reachable",
    visible,
  );
  if (fork) {
    assert.match(visible(), /Fork context: includes inherited parent activity/);
  }
  terminal.clear();
  terminal.send("\x1b[6~");
  await until(
    () => visible().includes(".jsonl"),
    "Details scrolls to the complete journal identity",
    visible,
  );
  terminal.clear();
  terminal.send("\x1b");
  await until(
    () =>
      view instanceof TuiAltScreen
        ? !visible().includes("Assignment preview")
        : terminal.text().includes("Following live"),
    "Escape closes Details before the viewer",
    visible,
  );
  terminal.clear();
  terminal.send("\x1b[5~");
  await until(
    () => /Reading earlier|New activity below/.test(visible()),
    "first-page Page Up suspends follow",
    visible,
  );
  if (view instanceof TuiAltScreen) {
    assert.match(
      visible(),
      /CHILD_TEXT_LIVE|observe_gate/,
      "Page Up at the beginning cannot blank the first conversation page",
    );
  }
  terminal.send("\x1b[F");
  await until(
    () => visible().includes("Following live"),
    "End returns from the first page",
    visible,
  );
}

async function exerciseReading(options: {
  t: TestContext;
  terminal: CaptureTerminal;
  screen: TuiAltScreen;
  mode: sdk.InteractiveMode;
  session: sdk.AgentSession;
  a: ReturnType<typeof usageLaunch>;
  b: ReturnType<typeof usageLaunch>;
}): Promise<void> {
  const { terminal, screen, a, b } = options;
  const native = sdk.SessionManager.open(a.sessionFile);
  native.appendMessage({ role: "user", content: "READING_FIXTURE", timestamp: 1 });
  for (let index = 0; index < 56; index++) {
    const marker = `HISTORY_${String(index).padStart(2, "0")}`;
    native.appendMessage(
      fauxAssistantMessage(`${marker}\n${`${marker} independent history row 雪😀 `.repeat(15)}\n`),
    );
  }
  const page = (label: string) => `${label}\n${"W".repeat(32768 - label.length - 2)}\n`;
  native.appendMessage(
    fauxAssistantMessage(`${page("PAGE_ONE")}${page("PAGE_TWO")}PAGE_THREE\nLATEST_TAIL`),
  );
  const other = sdk.SessionManager.open(b.sessionFile);
  other.appendMessage({ role: "user", content: "SECOND_READING_FIXTURE", timestamp: 1 });
  other.appendMessage(fauxAssistantMessage("OTHER_CHILD_ONLY"));
  const shown = () => screen.getScreenLines().map(stripTerminalSequences).join("\n");
  const overlays = spy(screen, "showOverlay");
  options.t.after(() => overlays.restore());
  let sent = 0;
  const keyUntil = (key: string, text: string, repeats = 1) =>
    until(
      () => {
        const overlay = overlays.lastCall;
        assertDefined(overlay);
        const transcript = components(overlay.args[0]).find(observesNativeProgress);
        assertDefined(transcript);
        // Paging placeholders can skip the target before its native journal read publishes.
        if (transcript.children.some((card) => "ready" in card && card.ready !== true)) {
          return false;
        }
        screen.renderNow();
        if (shown().includes(text)) {
          return true;
        }
        if (Date.now() - sent >= 100) {
          sent = Date.now();
          for (let index = 0; index < repeats; index++) {
            terminal.send(key);
          }
        }
        return false;
      },
      `keyboard reaches ${text}`,
      shown,
    );
  const command = options.mode.getUserInput().then((text) => options.session.prompt(text));
  terminal.send(`/agents ${a.id}`);
  terminal.send("\r");
  await until(
    () => shown().includes("LATEST_TAIL"),
    "opening starts at the latest content page",
    shown,
  );
  assert.match(shown(), /Content page 3\/3/);
  terminal.send("\x1b[5~");
  await until(
    () => shown().includes("Content page 2/3"),
    "backward content navigation lands at the previous page end",
    shown,
  );
  await keyUntil("\x1b[5~", "PAGE_TWO");
  terminal.send("\x1b[5~");
  await until(
    () => shown().includes("Content page 1/3"),
    "the next backward content navigation preserves its landing",
    shown,
  );
  await keyUntil("\x1b[5~", "PAGE_ONE");
  await keyUntil("\x1b[5~", "HISTORY_45");
  const anchor = shown().match(/HISTORY_\d+/)?.[0];
  assert.ok(anchor !== undefined);
  terminal.width = 46;
  terminal.resize?.();
  await until(
    () => visibleWidth(screen.getScreenLines()[0] ?? "") === 46,
    "reading resizes to46 columns",
  );
  assert.ok(shown().includes(anchor), "width reflow preserves the observed native entry");
  await keyUntil("\x1b[5~", "HISTORY_00");
  const saved = shown().match(/HISTORY_\d+/)?.[0];
  assert.ok(saved !== undefined);
  terminal.send("\t");
  await until(
    () => shown().includes("enter open"),
    "narrow Tab shows the actual child list",
    shown,
  );
  terminal.click(screen, "running · reader-b");
  await until(
    () => shown().includes("OTHER_CHILD_ONLY"),
    "switching hydrates only the selected child",
    shown,
  );
  assert.doesNotMatch(shown(), /HISTORY_\d+/);
  terminal.send("\t");
  await until(
    () => shown().includes("enter open"),
    "the second child can return to its list",
    shown,
  );
  terminal.click(screen, "running · reader-a");
  await until(
    () => shown().includes(saved),
    "returning restores the first child's entry anchor",
    shown,
  );
  assert.doesNotMatch(
    shown(),
    /OTHER_CHILD_ONLY/,
    "late hydration cannot replace the selected child",
  );
  await keyUntil("\x1b[6~", "HISTORY_45");
  assert.match(
    shown(),
    /Reading earlier|New activity below/,
    "forward history does not silently resume live follow",
  );
  terminal.send("\x1b[F");
  await until(
    () => shown().includes("LATEST_TAIL") && shown().includes("Following live"),
    "End returns to the latest page, not an old page of the last message",
    shown,
  );
  terminal.height = 12;
  terminal.resize?.();
  await keyUntil("\x1b[A", "Load earlier activity", 25);
  await until(
    () => !shown().includes("Loading published content") && /HISTORY_\d+/.test(shown()),
    "the top overlap card has rendered its published content",
    shown,
    5000,
  );
  const overlap = shown().match(/HISTORY_(\d+)/)?.[1];
  assert.ok(overlap !== undefined && Number(overlap) > 0, shown());
  terminal.click(screen, "Load earlier activity");
  await until(
    () =>
      [...shown().matchAll(/HISTORY_(\d+)/g)].some((match) => Number(match[1]) < Number(overlap)),
    "mouse history navigation reveals activity above a taller-than-viewport overlap card",
    shown,
    5000,
  );
  await keyUntil("\x1b[B", "Load later activity", 25);
  terminal.click(screen, "Load later activity");
  await until(
    () => shown().includes(`HISTORY_${overlap}`) && !shown().includes("Load later activity"),
    "mouse forward history keeps the overlap instead of jumping to the new window's bottom",
    shown,
    5000,
  );
  assert.match(shown(), /Reading earlier|New activity below/);
  assert.equal(
    options.session.isStreaming,
    false,
    "reading and switching never invoke the provider",
  );
  terminal.send("\x1b");
  terminal.send("\x1b");
  await command;
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
      const screenPrototype = {
        fullscreen: TuiAltScreen.prototype,
        regular: TuiMainScreen.prototype,
      }[tuiMode];
      const overlays = spy(screenPrototype, "showOverlay");
      t.after(() => overlays.restore());
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
        () => terminal.text(),
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
        () => terminal.text().includes("● watch-child 雪 ·"),
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
          () => screenLines().some((line) => line.includes("enter open")),
          "mouse Back returns to inventory",
          () => screenLines().join("\n"),
        );
        click("running · watch-child");
        await until(
          () => screenLines().some((line) => line.includes("CHILD_TEXT_LIVE")),
          "clicking an inventory row opens it",
        );
        terminal.width = 46;
        terminal.resize?.();
        await until(() => visibleWidth(screenLines()[0] ?? "") === 46, "narrow frame is rendered");
        click("escape back");
        await until(
          () => screenLines().some((line) => line.includes("enter open")),
          "narrow Back returns to inventory",
        );
        click("enter open");
        await until(
          () => screenLines().some((line) => line.includes("CHILD_TEXT_LIVE")),
          "narrow watch hint opens the child",
          () => screenLines().join("\n"),
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
        () => terminal.text().includes("watch-child") && terminal.text().includes("enter open"),
        "native key path lists child while parent streams",
      );
      const calls = requests(root);
      terminal.clear();
      terminal.height = 10;
      terminal.resize?.();
      await until(
        () => terminal.text().includes("> running · watch-child"),
        "selected child stays visible in a ten-row terminal",
        () => terminal.text(),
      );
      terminal.height = 32;
      terminal.resize?.();
      terminal.clear();
      terminal.send("\r");
      await until(
        () =>
          terminal.text().includes("CHILD_TEXT_LIVE") && terminal.text().includes("observe_gate"),
        "published assistant text and pending native tool call appear",
        () => terminal.text(),
      );
      assert.match(terminal.text(), /native-observe/);
      assert.match(terminal.text(), /Following live/);
      const visible = () =>
        view instanceof TuiAltScreen
          ? view.getScreenLines().map(stripTerminalSequences).join("\n")
          : terminal.text();
      await firstPageNavigation(terminal, view, tuiMode === "regular");
      const launch = record(JSON.parse(fs.readFileSync(path.join(runDir, "launch.json"), "utf8")));
      assert.ok(typeof launch.sessionFile === "string");
      const journalFile = launch.sessionFile;
      fs.writeFileSync(path.join(root, "progress-child"), "1");
      await until(
        () => visible().includes("LIVE_PROGRESS_1"),
        "actual native tool progress appears before its result exists",
        visible,
      );
      assert.doesNotMatch(
        fs.readFileSync(journalFile, "utf8"),
        /LIVE_PROGRESS_1/,
        "progress is transient, not an already-published result",
      );
      terminal.send("\r");
      await until(
        () => visible().includes("LIVE_PROGRESS_1_END"),
        "local expansion reveals the full native partial output",
        visible,
      );
      terminal.send("\x1b[5~");
      await until(
        () => /Reading earlier|New activity below/.test(visible()),
        "Page Up suspends following",
        visible,
      );
      const anchors = visible()
        .split("\n")
        .filter((line) => line.includes("LIVE_ROW_1_"));
      assert.ok(anchors.length > 0, "earlier partial-output rows are actually visible");
      const shown = overlays.lastCall;
      assertDefined(shown);
      const transcript = components(shown.args[0]).find(observesNativeProgress);
      assert.ok(transcript !== undefined);
      const observe = transcript.observe.bind(transcript);
      let processed = false;
      const observation = t.mock.method(transcript, "observe", (client?: ObservationClient) => {
        observe(client);
        processed ||= [...(client?.tools.values() ?? [])].some(
          (tool) =>
            tool.name === "observe_gate" &&
            tool.partial !== undefined &&
            record(record(record(tool.partial).json).details).progress === "2",
        );
      });
      terminal.clear();
      fs.writeFileSync(path.join(root, "progress-child"), "2");
      await until(
        () => processed,
        "selected viewer processes native progress 2 before checking the frozen viewport",
        visible,
      );
      observation.mock.restore();
      assert.ok(view !== undefined);
      view.renderNow(true);
      assert.match(visible(), /New activity below/);
      assert.doesNotMatch(
        visible(),
        /LIVE_ROW_2_/,
        "incoming progress does not reflow the earlier viewport",
      );
      if (view instanceof TuiAltScreen) {
        assert.deepEqual(
          visible()
            .split("\n")
            .filter((line) => line.includes("LIVE_ROW_1_")),
          anchors,
        );
      }
      terminal.send("\x1b[F");
      await until(
        () => visible().includes("LIVE_PROGRESS_2_END"),
        "End resumes live output and preserves local tool expansion",
        visible,
      );
      terminal.width = 46;
      terminal.resize?.();
      terminal.clear();
      const parses = await markdownParses(sdkRoot);
      t.after(() => parses.lexer.restore());
      fs.writeFileSync(path.join(root, "release-child"), "release");
      await until(
        () => terminal.text().includes("CHILD_STREAM_START"),
        "native assistant tokens render before message publication",
        visible,
      );
      assert.doesNotMatch(
        fs.readFileSync(journalFile, "utf8"),
        /CHILD_STREAM_START/,
        "visible assistant text is genuinely live",
      );
      assert.match(terminal.text(), /CHILD_THINKING_FACT/);
      await until(
        () => terminal.text().includes("Child streaming row 20"),
        "the live answer keeps growing below its completed thinking",
        visible,
      );
      const thinking = parses.count("CHILD_THINKING_FACT");
      assert.ok(parses.count("CHILD_STREAM_START") > 1, "several answer revisions have rendered");
      assert.doesNotMatch(
        fs.readFileSync(journalFile, "utf8"),
        /CHILD_FINAL_FACT/,
        "the parse count covers only the live message",
      );
      parses.assertReused(thinking);
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
        () =>
          (view instanceof TuiAltScreen
            ? view.getScreenLines().map(stripTerminalSequences).join("\n")
            : terminal.text()
          ).includes("completed"),
        "completed messageable actor is not counted as active work",
        () =>
          view instanceof TuiAltScreen
            ? view.getScreenLines().map(stripTerminalSequences).join("\n")
            : terminal.text(),
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
      assert.match(
        terminal.text(),
        /Agents: 0 active/,
        "the canonical completed idle actor is not active work",
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
      assert.doesNotMatch(terminal.text(), /\.jsonl/, "journal paths stay behind Details");
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
          })
        ).details,
      );
      assert.equal(adopted.sessionFile, originalFile);
      assert.equal(adopted.sessionId, legacy.getSessionId());
      assert.ok(typeof adopted.id === "string");
      const commands = path.join(base, adopted.id, "commands");
      // The parent's completion notice turn must settle before observation counts requests.
      const finished = async (id: string) => {
        await until(
          () =>
            manager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom_message" &&
                  entry.customType === "agent-completion" &&
                  typeof entry.details === "object" &&
                  entry.details !== null &&
                  "id" in entry.details &&
                  entry.details.id === id,
              ),
          `asynchronous child ${id} completion reaches the parent`,
        );
        await runtime.session.waitForIdle();
      };
      await finished(adopted.id);
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
          })
        ).details,
      );
      assert.ok(typeof continued.id === "string");
      assert.notEqual(continued.id, adopted.id);
      await finished(continued.id);
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
      await watch(continued.id, "Child journal is not a regular file");
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
        () =>
          (view instanceof TuiAltScreen
            ? view.getScreenLines().map(stripTerminalSequences).join("\n")
            : terminal.text()
          ).includes("No child runs"),
        "replacement cannot mix previous owner's children",
        () =>
          view instanceof TuiAltScreen
            ? view.getScreenLines().map(stripTerminalSequences).join("\n")
            : terminal.text(),
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
  "native observer caches completed metadata, probes each active root once per tick, strips only active work and resolves ambiguity beyond its row cache",
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
    // Keep stopped history in the final metadata batch with the active runs.
    const stoppedId = ids.at(-3);
    assert.ok(firstId !== undefined && secondId !== undefined && stoppedId !== undefined);
    const completedIds = new Set(ids.slice(0, -2));
    const stoppedLaunch = record(
      JSON.parse(fs.readFileSync(path.join(base, stoppedId, "launch.json"), "utf8")),
    );
    write(path.join(base, stoppedId, "launch.json"), { ...stoppedLaunch, name: "stopped-history" });
    write(path.join(base, stoppedId, "result.json"), {
      id: stoppedId,
      owner,
      status: "stopped",
      endedAt: 1,
    });
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
    let view: TUI | undefined;
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
    const probes = spy(process, "kill");
    const scans = spy(fs, "readdirSync");
    syncBuiltinESMExports();
    const opened = () =>
      opens.getCalls().flatMap((call) => {
        const args: readonly unknown[] = call.args;
        return typeof args[0] === "string" ? [args[0]] : [];
      });
    const identityProbes = () =>
      probes.getCalls().filter((call) => {
        const args: readonly unknown[] = call.args;
        return args[0] === process.pid && args[1] === 0;
      }).length;
    const scanned = () =>
      scans.getCalls().some((call) => {
        const args: readonly unknown[] = call.args;
        return args[0] === base;
      });
    t.after(async () => {
      try {
        if (t.signal.aborted) {
          t.diagnostic(
            `Cancelled observer-cache state: ${JSON.stringify({
              screen: view instanceof TuiAltScreen ? view.getScreenLines() : [],
              terminalTail: terminal.output.slice(-8192),
              opens: opened().slice(-20),
              scans: scans.callCount,
              probes: identityProbes(),
            })}`,
          );
        }
      } finally {
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
      }
    });
    await mode.init();
    assert.ok(view instanceof TuiAltScreen);
    const screen = view;
    const shown = () => screen.getScreenLines().map(stripTerminalSequences).join("\n");
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
    await until(
      () => terminal.text().includes("stopped · stopped-history"),
      "explicit inventory keeps stopped history",
    );
    terminal.send("\x1b");
    await loading;
    await until(
      () =>
        !shown().includes("Agents · read-only") &&
        shown().includes("● active-first · running") &&
        shown().includes("● active-second · running"),
      "strip renders the completed inventory scan after the picker closes",
      shown,
    );
    assert.doesNotMatch(shown(), /stopped-history/, "stopped history stays out of the strip");
    assert.equal(opened().filter((file) => file.endsWith("/launch.json")).length, 122);
    assert.ok(
      identityProbes() >= 1,
      "cold inventory proves liveness before presenting active runs",
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
    assert.equal(identityProbes(), 1, "one actual PID liveness probe per active root per tick");
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
      () =>
        shown().includes("Agents: 1 active · 122 runs") &&
        shown().includes("● active-second · running"),
      "missing-result predecessor no longer inherits the successor's liveness",
      shown,
    );
    assert.doesNotMatch(shown(), /active-first|stopped-history/, "strip lists active work only");
    terminal.click(screen, "● active-second");
    await until(
      () => shown().includes("running · active-second") && shown().includes("escape back"),
      "clicking the active strip row watches it",
      shown,
    );
    terminal.send("\x1b");
    await until(
      () =>
        shown().includes("interrupted · active-first") &&
        shown().includes("stopped · stopped-history"),
      "watch returns to the explicit inventory with saved history",
      shown,
    );
    terminal.send("\x1b");
    await until(() => !shown().includes("Agents · read-only"), "inventory closes", shown);
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
      () => !shown().includes("Agents:"),
      "fully scanned zero-active work removes the strip despite interrupted and stopped history",
      shown,
    );
    terminal.clear();
    const retired = mode.getUserInput().then((text) => runtime.session.prompt(text));
    terminal.send("/agents");
    terminal.send("\r");
    await until(
      () =>
        terminal.text().includes("Agents: 0 active · 122 runs") &&
        terminal.text().includes("interrupted · active-first") &&
        terminal.text().includes("stopped · stopped-history"),
      "completed successor cannot make the interrupted predecessor look active in the inventory",
    );
    assert.doesNotMatch(terminal.text(), /completed · active-second/);
    terminal.send("\x1b");
    await retired;
    const unreadable = path.join(base, "foreign-owner");
    write(path.join(unreadable, "launch.json"), {
      ...active,
      id: "foreign-owner",
      rootId: "foreign-owner",
      owner: "another-native-parent",
    });
    await until(
      () =>
        shown().includes("○ foreign-owner · unavailable") && shown().includes("inventory error"),
      "an unreadable run keeps uncertainty in the zero-active strip",
      shown,
    );
    fs.rmSync(unreadable, { recursive: true });
    await until(() => !shown().includes("Agents:"), "resolved uncertainty clears the strip", shown);
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
    const a = { ...publish("reader-a", false), name: "reader-a" };
    const b = { ...publish("reader-b", false), name: "reader-b" };
    write(path.join(base, a.id, "launch.json"), a);
    write(path.join(base, b.id, "launch.json"), b);
    await exerciseReading({ t, terminal, screen, mode, session: runtime.session, a, b });
  },
);
