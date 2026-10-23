import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { json, numberValue, text } from "./assertions.ts";

type Options = {
  source: string;
  host: string;
  output: string;
  tmux: string;
  mode: "fullscreen" | "regular";
  managed: boolean;
};
type ProcessIdentity = { pid: number; birth: string; role: string };
type Evidence = {
  status: "running" | "passed" | "failed";
  checks: string[];
  failures: string[];
  cleanup: string[];
  limitations: string[];
  metrics: Record<string, unknown>;
};

function options(): Options {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const allowed = new Set(["--source", "--host", "--output", "--tmux", "--mode"]);
  let managed = false;
  for (let i = 0; i < args.length;) {
    const key = args[i];
    if (key === "--managed") {
      assert.ok(!managed, "Duplicate option --managed");
      managed = true;
      i += 1;
      continue;
    }
    const value = args.at(i + 1);
    assert.ok(allowed.has(key) && value !== undefined, `Invalid option ${key}`);
    assert.ok(!values.has(key), `Duplicate option ${key}`);
    values.set(key, value);
    i += 2;
  }
  const source = values.get("--source");
  const host = values.get("--host");
  const output = values.get("--output");
  assert.ok(
    source !== undefined && host !== undefined && output !== undefined,
    "Required: --source PATH --host SDK_ROOT --output NEW_DIR",
  );
  const mode = values.get("--mode") ?? "fullscreen";
  assert.ok(mode === "fullscreen" || mode === "regular");
  return {
    source: fs.realpathSync(source),
    host: fs.realpathSync(host),
    output: path.resolve(output),
    tmux: values.get("--tmux") ?? "/opt/homebrew/bin/tmux",
    mode,
    managed,
  };
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function rows(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const data = fs.readFileSync(file, "utf8");
  // A concurrent append is not yet a published JSONL record.
  return data
    .slice(0, data.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map(json);
}
function birth(pid: number): string {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status === 1) {
    return "";
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function alive(identity: ProcessIdentity): boolean {
  return birth(identity.pid) === identity.birth;
}
function hash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function message(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error);
}
function outputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
class Proof {
  readonly options: Options;
  readonly runtime: string;
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
  readonly report: Evidence = {
    status: "running",
    checks: [],
    failures: [],
    cleanup: [],
    metrics: {},
    limitations: [
      "One deterministic child, one parent, one execution per host and mode.",
      "CPU deltas come from ps cumulative time on one process, not a profile or event-loop metric.",
      "Raw bytes include startup, parent UI, polling redraws, resize and shutdown.",
      "Offline and an allowlisted empty-credential environment prevent ordinary provider use; no network syscall trace is collected.",
    ],
  };
  readonly actors = new Map<number, ProcessIdentity>();
  readonly deadline = Date.now() + 120_000;
  readonly eventFile: string;
  readonly socket: string;
  server?: ProcessIdentity;
  runDir?: string;
  cancelled?: Error;
  constructor(opts: Options) {
    this.options = opts;
    fs.mkdirSync(opts.output, { recursive: false });
    this.runtime = fs.mkdtempSync("/tmp/pi-pty-");
    this.project = path.join(this.runtime, "project");
    this.eventFile = path.join(opts.output, "pty-events.jsonl");
    this.socket = path.join(this.runtime, "tmux.sock");
    const home = path.join(opts.output, "home");
    const agentDir = path.join(home, ".pi", "agent");
    for (const directory of [agentDir, this.project]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const fixture = fileURLToPath(new URL("../fixtures/agent-observe-pty.ts", import.meta.url));
    this.env = {
      HOME: home,
      USERPROFILE: home,
      PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "en_US.UTF-8",
      TERM: "tmux-256color",
      SHELL: "/bin/sh",
      TMPDIR: this.runtime,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_PACKAGE_DIR: opts.host,
      PI_INTERCOM_RUNTIME_DIR: path.join(this.runtime, "ipc"),
      PI_SUBAGENT_TEMP_ROOT: path.join(opts.output, "pi-subagents-temp"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      OBSERVE_TEST_ROOT: opts.output,
    };
    this.save("environment.json", this.env);
    this.saveAt(path.join(agentDir, "settings.json"), {
      extensions: [fixture],
      quietStartup: true,
      theme: "dark",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    if (opts.managed) {
      this.install();
    }
  }
  private cli(): string {
    const manifest = json(fs.readFileSync(path.join(this.options.host, "package.json"), "utf8"));
    assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
    return path.resolve(this.options.host, text(json(JSON.stringify(manifest.bin)).pi));
  }
  private install(): void {
    const packages = path.join(this.options.output, "package");
    fs.mkdirSync(packages);
    this.command("npm", ["pack", this.options.source, "--pack-destination", packages, "--silent"]);
    const archives = fs.readdirSync(packages).filter((file) => file.endsWith(".tgz"));
    assert.equal(archives.length, 1, "npm pack must produce one archive");
    const tarball = path.join(packages, archives[0]);
    const unpacked = path.join(packages, "unpacked");
    fs.mkdirSync(unpacked);
    this.command("/usr/bin/tar", ["-xzf", tarball, "-C", unpacked]);
    const installed = path.join(unpacked, "package");
    this.command(
      "npm",
      [
        "install",
        "--prefix",
        installed,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--silent",
      ],
      true,
      60000,
    );
    this.command(this.cli(), ["install", installed, "--approve"]);
    const listed = this.command(this.cli(), ["list", "--approve"]);
    assert.ok(listed.includes(installed), `pi list did not include managed package:\n${listed}`);
    this.report.checks.push("packed package installed and listed through managed Pi discovery");
    this.save("managed-install.json", {
      tarball,
      sha256: hash(tarball),
      installed,
      listed: listed.trim(),
      settings: json(
        fs.readFileSync(path.join(this.env.PI_CODING_AGENT_DIR ?? "", "settings.json"), "utf8"),
      ),
    });
  }
  saveAt(file: string, data: unknown): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
  save(name: string, data: unknown): void {
    this.saveAt(path.join(this.options.output, name), data);
  }
  command(binary: string, args: string[], required = true, timeout = 5000): string {
    const result = spawnSync(binary, args, {
      env: this.env,
      cwd: this.project,
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    fs.appendFileSync(
      path.join(this.options.output, "commands.jsonl"),
      JSON.stringify({
        at: Date.now(),
        binary,
        args,
        status: result.status,
        signal: result.signal,
        stdoutBytes: Buffer.byteLength(outputText(result.stdout)),
        stderr: result.stderr,
        error: result.error?.message,
      }) + "\n",
    );
    if (required) {
      assert.equal(result.status, 0, `${binary} ${args.join(" ")}\n${result.stderr}`);
    }
    return outputText(result.stdout);
  }
  tmux(args: string[], required = true): string {
    return this.command(this.options.tmux, ["-S", this.socket, ...args], required);
  }
  events(kind: string): Record<string, unknown>[] {
    return rows(this.eventFile).filter((event) => event.kind === kind);
  }
  async until(check: () => boolean, label: string, timeout = 20000): Promise<void> {
    const deadline = Math.min(this.deadline, Date.now() + timeout);
    while (!check()) {
      if (this.cancelled) {
        throw this.cancelled;
      }
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      // Polls join observed publication. Elapsed time never proves a negative result.
      // oxlint-disable-next-line no-await-in-loop
      await delay(40);
    }
    this.report.checks.push(label);
  }
  screen(): string {
    return this.tmux(["capture-pane", "-p", "-t", "proof:0.0"]);
  }
  capture(label: string): string {
    const screen = this.screen();
    fs.writeFileSync(path.join(this.options.output, `${label}.txt`), screen);
    fs.writeFileSync(
      path.join(this.options.output, `${label}.ansi`),
      this.tmux(["capture-pane", "-p", "-e", "-t", "proof:0.0"]),
    );
    return screen;
  }
  async visible(expected: string, label: string): Promise<void> {
    await this.until(() => this.screen().includes(expected), label);
    this.capture(label);
  }
  async key(value: string, acknowledge = true): Promise<void> {
    const count = this.events("input").length;
    this.tmux(["send-keys", "-t", "proof:0.0", value]);
    if (acknowledge) {
      await this.until(() => this.events("input").length > count, `terminal received ${value}`);
    }
  }
  async line(value: string): Promise<void> {
    this.tmux(["send-keys", "-l", "-t", "proof:0.0", value]);
    await this.key("Enter");
  }
  remember(pid: number, role: string): void {
    if (this.actors.has(pid)) {
      return;
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    const identity = birth(pid);
    if (identity !== "") {
      this.actors.set(pid, { pid, birth: identity, role });
    }
  }
  discover(): void {
    for (const event of this.events("start")) {
      this.remember(numberValue(event.pid), event.child === true ? "child" : "parent");
    }
    if (this.runDir !== undefined) {
      const file = path.join(this.runDir, "actor.lock", "process.json");
      if (fs.existsSync(file)) {
        this.remember(numberValue(json(fs.readFileSync(file, "utf8")).pid), "child");
      }
    }
    const brokerFile = path.join(this.env.PI_INTERCOM_RUNTIME_DIR ?? "", "broker.pid");
    if (fs.existsSync(brokerFile)) {
      this.remember(Number(fs.readFileSync(brokerFile, "utf8").split("\n")[0]), "broker");
    }
    if (this.server && alive(this.server)) {
      const helpers = this.command("/usr/bin/pgrep", ["-P", String(this.server.pid)], false);
      for (const pid of helpers.trim().split(/\s+/).filter(Boolean)) {
        this.remember(Number(pid), "tmux-helper");
      }
    }
    for (const actor of this.actors.values()) {
      if (alive(actor)) {
        const children = this.command("/usr/bin/pgrep", ["-P", String(actor.pid)], false);
        for (const pid of children.trim().split(/\s+/).filter(Boolean)) {
          this.remember(Number(pid), actor.role === "tmux-helper" ? "tmux-helper" : "descendant");
        }
      }
      assert.ok(this.actors.size <= 30, "Bounded fixture process tree");
    }
  }
  identities(): void {
    const git = (args: string[]) => this.command("/usr/bin/git", args).trim();
    const manifest = json(fs.readFileSync(path.join(this.options.host, "package.json"), "utf8"));
    const cli = this.cli();
    const files = [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL("../fixtures/agent-observe-pty.ts", import.meta.url)),
      fileURLToPath(new URL("../fixtures/agent-observe-provider.ts", import.meta.url)),
      ...[
        "src/index.ts",
        "src/agent/observe.ts",
        "src/agent/observe-screen.ts",
        "src/agent/journal-tail.ts",
        "package-lock.json",
      ].map((file) => path.join(this.options.source, file)),
      path.join(this.options.host, "package.json"),
      path.join(this.options.host, "dist/index.js"),
      cli,
    ];
    this.save("identity.json", {
      at: new Date().toISOString(),
      command: [process.execPath, ...process.argv.slice(1)],
      node: {
        execPath: process.execPath,
        realPath: fs.realpathSync(process.execPath),
        version: process.version,
      },
      machine: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
      },
      source: {
        path: this.options.source,
        commit: git(["-C", this.options.source, "rev-parse", "HEAD"]),
        status: git(["-C", this.options.source, "status", "--short"]),
        diff: git(["-C", this.options.source, "diff", "--", "src"]),
      },
      host: {
        path: this.options.host,
        version: manifest.version,
        gitHead: manifest.gitHead ?? null,
        cli,
        observedVersion: this.command(process.execPath, [cli, "--version"]).trim(),
      },
      tmux: this.command(this.options.tmux, ["-V"]).trim(),
      hashes: Object.fromEntries(files.map((file) => [file, hash(file)])),
      socket: this.socket,
      runtime: this.runtime,
      project: this.project,
      mode: this.options.mode,
      managed: this.options.managed,
      install: this.options.managed
        ? json(fs.readFileSync(path.join(this.options.output, "managed-install.json"), "utf8"))
        : null,
      initialSize: { columns: 100, rows: 32 },
    });
  }
  launch(): void {
    const args = [
      process.execPath,
      this.cli(),
      "--offline",
      "--approve",
      ...(this.options.managed ? [] : ["--no-extensions"]),
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--tui-mode",
      this.options.mode,
      ...(this.options.managed ? [] : ["-e", path.join(this.options.source, "src/index.ts")]),
      "-e",
      fileURLToPath(new URL("../fixtures/agent-observe-pty.ts", import.meta.url)),
      "--provider",
      "observe-fixture",
      "--model",
      "native-observe",
      "--thinking",
      "off",
      "--session-dir",
      path.join(this.options.output, "parent-sessions"),
    ];
    this.tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "proof",
      "-x",
      "100",
      "-y",
      "32",
      "/bin/sleep",
      "120",
    ]);
    const pid = Number(this.tmux(["display-message", "-p", "#{pid}"]).trim());
    this.server = { pid, birth: birth(pid), role: "tmux" };
    this.tmux(["set-option", "-t", "proof", "remain-on-exit", "on"]);
    this.tmux([
      "pipe-pane",
      "-O",
      "-t",
      "proof:0.0",
      `exec /bin/cat > ${quote(path.join(this.options.output, "terminal.raw"))}`,
    ]);
    const wrapper = `${args.map(quote).join(" ")}; code=$?; printf '%s\\n' "$code" > ${quote(path.join(this.options.output, "parent-exit.txt"))}; exit "$code"`;
    const env = Object.entries(this.env).map(([key, value]) => `${key}=${value ?? ""}`);
    this.tmux([
      "respawn-pane",
      "-k",
      "-t",
      "proof:0.0",
      "-c",
      this.project,
      "/usr/bin/env",
      "-i",
      ...env,
      "/bin/sh",
      "-c",
      wrapper,
    ]);
    this.remember(
      Number(this.tmux(["display-message", "-p", "-t", "proof:0.0", "#{pane_pid}"]).trim()),
      "wrapper",
    );
  }
  async ready(): Promise<void> {
    await this.until(
      () => this.events("start").some((event) => event.child === false),
      "native-parent-start",
    );
    const parent = this.events("start").find((event) => event.child === false);
    assert.ok(parent);
    assert.equal(parent.mode, "tui");
    assert.equal(parent.stdinTTY, true);
    assert.equal(parent.stdoutTTY, true);
    assert.equal(parent.execPath, process.execPath);
    await this.line("START_OBSERVE");
    await this.until(
      () =>
        ["child-ready", "parent-ready"].every((file) =>
          fs.existsSync(path.join(this.options.output, file)),
        ),
      "both-held-actors-ready",
    );
    const child = this.events("start").find((event) => event.child === true);
    assert.ok(child);
    assert.equal(child.mode, "print");
    assert.equal(child.execPath, process.execPath);
    assert.equal(child.sdk, this.options.host);
    const base = path.join(
      this.env.PI_CODING_AGENT_DIR ?? "",
      "sessions",
      "agent-runs",
      text(parent.sessionId),
    );
    const runs = fs
      .readdirSync(base)
      .filter((id) => fs.existsSync(path.join(base, id, "launch.json")));
    assert.equal(runs.length, 1);
    this.runDir = path.join(base, text(runs[0]));
    await this.until(
      () => fs.existsSync(path.join(this.runDir ?? "", "ready.json")),
      "native-child-ready-publication",
    );
    const launch = json(fs.readFileSync(path.join(this.runDir, "launch.json"), "utf8"));
    assert.equal(launch.sessionId, child.sessionId);
    assert.equal(launch.owner, parent.sessionId);
    this.discover();
    this.save("actors-ready.json", [...this.actors.values()]);
    assert.equal(rows(path.join(this.options.output, "requests.jsonl")).length, 3);
    await this.visible("watch-child", "01-parent-child-ready");
  }
  async checkpoint(idle: boolean): Promise<void> {
    const count = this.events("checkpoint").length;
    await this.line("/pty-proof-state");
    await this.until(
      () => this.events("checkpoint").length === count + 1,
      "native-state-command-processed",
    );
    assert.equal(this.events("checkpoint").at(-1)?.idle, idle);
  }
  private parent?: number;
  piPid(): number {
    if (this.parent === undefined) {
      const parent = this.events("start").find((event) => event.child === false);
      assert.ok(parent !== undefined);
      this.parent = numberValue(parent.pid);
      assert.ok(this.parent > 1);
    }
    return this.parent;
  }
  cpuSeconds(): number {
    const raw = this.command("/bin/ps", ["-o", "time=", "-p", String(this.piPid())], false).trim();
    const parts = raw.split(":").map(Number);
    assert.ok(
      parts.length >= 2 && parts.every((part) => Number.isFinite(part)),
      `Unreadable cputime ${JSON.stringify(raw)} for pid ${this.piPid()}`,
    );
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  async sample(label: string, milliseconds: number): Promise<{ cpu: number; bytes: number }> {
    const raw = path.join(this.options.output, "terminal.raw");
    const cpu = this.cpuSeconds();
    const bytes = fs.statSync(raw).size;
    const started = Date.now();
    await delay(milliseconds);
    const sample = {
      cpuSeconds: Number((this.cpuSeconds() - cpu).toFixed(2)),
      terminalBytes: fs.statSync(raw).size - bytes,
      windowMs: Date.now() - started,
    };
    this.report.metrics[label] = sample;
    return { cpu: sample.cpuSeconds, bytes: sample.terminalBytes };
  }
  progress(value: string): void {
    fs.writeFileSync(path.join(this.options.output, "progress-child"), value);
  }
  lineOf(marker: string): number {
    return this.screen()
      .split("\n")
      .findIndex((line) => line.includes(marker));
  }
  async holds(marker: string, label: string): Promise<void> {
    await this.until(() => this.screen().includes(marker), label);
    this.capture(label);
  }
  async exercise(): Promise<void> {
    await this.line("/agents");
    await this.until(
      () => this.events("ui_start").some((event) => event.promptKind === "custom"),
      "native-custom-view-opened",
    );
    await this.visible("watch-child", "02-inventory");
    for (const key of ["Down", "Up"]) {
      // oxlint-disable-next-line no-await-in-loop
      await this.key(key);
    }
    await this.key("Enter");
    await this.holds("CHILD_TEXT_LIVE", "03-live-transcript");
    await this.holds("Following live", "04-following-live");
    const idleOpen = await this.sample("idle-open", 4000);

    this.progress("A");
    await this.holds("LIVE_PROGRESS_A", "05-live-progress");
    const streamCpu = this.cpuSeconds();
    const streamBytes = fs.statSync(path.join(this.options.output, "terminal.raw")).size;
    const streamStarted = Date.now();
    for (const value of ["B", "C", "D", "E", "F", "G", "H", "I"]) {
      this.progress(value);
      // oxlint-disable-next-line no-await-in-loop
      await delay(450);
    }
    await this.holds("LIVE_PROGRESS_I", "06-streaming");
    const streamSeconds = Number((this.cpuSeconds() - streamCpu).toFixed(2));
    this.report.metrics.stream = {
      cpuSeconds: streamSeconds,
      terminalBytes: fs.statSync(path.join(this.options.output, "terminal.raw")).size - streamBytes,
      windowMs: Date.now() - streamStarted,
      updates: 8,
    };
    assert.ok(streamSeconds <= 4, "eight live updates stay within four CPU seconds");

    await this.key("Up");
    await this.until(() => {
      const screen = this.screen();
      return screen.includes("Reading earlier") || screen.includes("New activity below");
    }, "follow-suspended");
    this.capture("07-suspended");
    const anchor = this.lineOf("CHILD_TEXT_LIVE");
    assert.ok(anchor >= 0);
    this.progress("J");
    await delay(900);
    this.capture("08-suspended-update");
    assert.equal(
      this.lineOf("CHILD_TEXT_LIVE"),
      anchor,
      "suspended view does not move on new activity",
    );
    assert.ok(!this.screen().includes("Following live"));
    await this.key("End");
    await this.holds("LIVE_PROGRESS_J", "09-resumed");
    await this.holds("Following live", "10-following-again");

    for (const label of ["11-earlier", "12-earlier-top"]) {
      // oxlint-disable-next-line no-await-in-loop
      await this.key("PPage");
      // oxlint-disable-next-line no-await-in-loop
      await delay(250);
      this.capture(label);
      const screen = this.screen();
      assert.ok(screen.includes("OBSERVE_CHILD") || screen.includes("CHILD_TEXT_LIVE"), label);
    }
    await this.key("End");
    await this.holds("LIVE_PROGRESS_J", "13-return-live");

    for (const [columns, height] of [
      [46, 18],
      [100, 32],
    ]) {
      this.tmux(["resize-window", "-t", "proof", "-x", String(columns), "-y", String(height)]);
      // oxlint-disable-next-line no-await-in-loop
      await this.until(
        () =>
          this.events("resize").some((event) => event.columns === columns && event.rows === height),
        `native-resize-${columns}x${height}`,
      );
      // oxlint-disable-next-line no-await-in-loop
      await this.holds("LIVE_PROGRESS_J", `14-resize-${columns}x${height}`);
    }

    await this.key("C-p");
    await this.holds("Assignment preview: OBSERVE_CHILD", "15-details");
    await this.key("Escape");
    await this.holds("LIVE_PROGRESS_J", "16-details-closed");

    await this.key("Escape");
    await this.until(() => {
      const screen = this.screen();
      return screen.includes("watch-child") && !screen.includes("CHILD_TEXT_LIVE");
    }, "native-back-to-list");
    const idleClosed = await this.sample("idle-closed", 4000);
    await this.key("Enter");
    await this.holds("CHILD_TEXT_LIVE", "17-reopened-live");
    await this.holds("Following live", "18-reopened-following");
    assert.ok(
      idleOpen.cpu - idleClosed.cpu <= 0.6,
      "open idle CPU stays within 0.6s of closed idle",
    );
    assert.ok(
      idleOpen.bytes - idleClosed.bytes <= 8192,
      "open idle adds at most 8KiB of terminal output",
    );

    fs.writeFileSync(path.join(this.options.output, "release-child"), "release");
    await this.until(
      () => fs.existsSync(path.join(this.runDir ?? "", "result.json")),
      "native-child-completion-published",
    );
    await this.holds("CHILD_FINAL_FACT", "19-child-finished");
    await this.until(() => !this.screen().includes("> running"), "settled-child-row");
    const settled = this.screen();
    assert.ok(!settled.includes("Awaiting journal publication"));
    this.capture("20-settled");
    await this.key("Escape");
    await this.until(() => {
      const screen = this.screen();
      return (
        screen.includes("Agents: ") &&
        !screen.includes("CHILD_FINAL_FACT") &&
        !screen.includes("Following live")
      );
    }, "native-back-to-list-after-settle");
    await this.key("Escape");
    await this.checkpoint(false);
    this.capture("21-closed-parent-still-busy");
    // Deterministic pre-completion requests: parent delegation + held follow-up, child reply + tool result.
    assert.equal(rows(path.join(this.options.output, "requests.jsonl")).length, 4);
    assert.ok([...this.actors.values()].every(alive));
    const result = json(fs.readFileSync(path.join(this.runDir ?? "", "result.json"), "utf8"));
    assert.equal(result.status, "completed");
    const childOutput = fs.readFileSync(path.join(this.runDir ?? "", "output.txt"), "utf8");
    assert.ok(childOutput.startsWith("CHILD_STREAM_START"));
    assert.ok(childOutput.trimEnd().endsWith("CHILD_FINAL_FACT"));
    const starts = this.events("start");
    const child = starts.find((event) => event.child === true);
    assert.ok(child);
    const journal = rows(text(child.sessionFile));
    const terminal = journal.find((entry) => entry.id === result.terminalEntryId);
    assert.ok(terminal, "canonical terminal entry exists in the actual native journal");
    assert.ok(JSON.stringify(terminal).includes("CHILD_FINAL_FACT"));
    fs.writeFileSync(path.join(this.options.output, "release-parent"), "release");
    await this.until(() => {
      const contexts = this.events("provider_context").filter((event) => event.child === false);
      const completion = contexts.at(2);
      return (
        completion !== undefined &&
        this.events("agent_settled").some(
          (event) => event.child === false && numberValue(event.at) >= numberValue(completion.at),
        )
      );
    }, "native-parent-completion-notice-settled");
    await this.checkpoint(true);
    await this.visible("PARENT_FINAL_FACT", "22-parent-final");
    const requests = rows(path.join(this.options.output, "requests.jsonl"));
    assert.equal(requests.filter((request) => request.child === true).length, 2);
    assert.equal(requests.filter((request) => request.child === false).length, 3);
    const contexts = this.events("provider_context").filter((event) => event.child === false);
    assert.equal(contexts.length, 3);
    assert.equal(contexts.at(-1)?.lastCustomType, "agent-completion");
    assert.ok(this.events("agent_settled").every((event) => event.aborted === false));
    assert.ok(
      this.events("assistant_end").every((event) =>
        ["toolUse", "stop"].includes(text(event.stopReason)),
      ),
    );
    this.save("request-audit.json", {
      parent: 3,
      child: 2,
      requests,
      contexts,
      explanation:
        "Parent requests are delegation, held follow-up, then the native agent-completion notification. Viewer interaction adds none while both actors are held.",
      settlementObserved: true,
    });
    await this.line("/quit");
    await this.until(
      () => fs.existsSync(path.join(this.options.output, "parent-exit.txt")),
      "native-parent-quit",
    );
    assert.equal(
      fs.readFileSync(path.join(this.options.output, "parent-exit.txt"), "utf8").trim(),
      "0",
    );
    await this.until(
      () =>
        [...this.actors.values()]
          .filter((actor) => actor.role !== "broker")
          .filter((actor) => actor.role !== "tmux-helper")
          .every((actor) => !alive(actor)),
      "owned-native-actors-exited",
    );
  }

  async cleanup(): Promise<void> {
    this.discover();
    for (const file of ["release-child", "release-parent"]) {
      fs.writeFileSync(path.join(this.options.output, file), "cleanup-release");
    }
    for (const role of ["native", "broker"]) {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        this.discover();
        const targets = [...this.actors.values()].filter((actor) =>
          role === "broker"
            ? actor.role === "broker"
            : !["broker", "tmux-helper"].includes(actor.role),
        );
        for (const actor of targets) {
          if (alive(actor)) {
            process.kill(actor.pid, signal);
            this.report.cleanup.push(`${signal} owned ${actor.role} ${actor.pid}`);
          }
        }
        const deadline = Date.now() + 5000;
        while (targets.some(alive) && Date.now() < deadline) {
          // oxlint-disable-next-line no-await-in-loop
          await delay(40);
        }
      }
    }
    this.tmux(["kill-server"], false);
    const deadline = Date.now() + 5000;
    while (
      [...this.actors.values(), ...(this.server ? [this.server] : [])].some(alive) &&
      Date.now() < deadline
    ) {
      // oxlint-disable-next-line no-await-in-loop
      await delay(40);
    }
    const survivors = [...this.actors.values(), ...(this.server ? [this.server] : [])].filter(
      alive,
    );
    this.save("actors-exit.json", {
      actors: [...this.actors.values()],
      server: this.server,
      survivors,
    });
    assert.deepEqual(survivors, [], "Every discovered owned process exited");
    assert.ok(fs.statSync(path.join(this.options.output, "terminal.raw")).size > 0);
    this.report.cleanup.push(
      "Owned native actors, broker and tmux server exited; artifacts retained.",
    );
    fs.rmSync(this.runtime, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const proof = new Proof(options());
  const cancel = (signal: string) => {
    proof.cancelled = new Error(`Interrupted by ${signal}`);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, cancel);
  }
  try {
    proof.identities();
    proof.launch();
    await proof.ready();
    await proof.exercise();
    proof.report.status = "passed";
  } catch (error) {
    proof.report.status = "failed";
    proof.report.failures.push(message(error));
    fs.writeFileSync(
      path.join(proof.options.output, "failure-screen.txt"),
      proof.tmux(["capture-pane", "-p", "-t", "proof:0.0"], false),
    );
    process.exitCode = 1;
  } finally {
    try {
      await proof.cleanup();
    } catch (error) {
      proof.report.status = "failed";
      proof.report.failures.push(`Cleanup: ${message(error)}`);
      process.exitCode = 1;
    }
    proof.save("report.json", proof.report);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.off(signal, cancel);
    }
    console.log(`${proof.report.status}: ${proof.options.output}/report.json`);
  }
}

await main();
