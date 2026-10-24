#!/usr/bin/env python3
"""Synthetic Pi CLI/RPC attach probe. Never reads existing sessions or credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import statistics
import subprocess
import time

OBSERVER = r'''
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const { default: agents } = await import(pathToFileURL(path.join(process.env.BENCH_REPO, "dist/agent/index.js")).href);
const emit = (value) => fs.writeSync(1, JSON.stringify(value) + "\n");
let active = false;
let counters = {};
if (process.env.BENCH_PROFILE === "1") {
  for (const name of ["mkdirSync", "openSync", "writeFileSync", "fsyncSync", "renameSync", "readdirSync", "lstatSync", "statSync", "readSync", "readFileSync"]) {
    const original = fs[name];
    fs[name] = (...args) => {
      if (!active) return original(...args);
      const started = performance.now();
      try { return original(...args); }
      finally {
        const row = counters[name] ??= {calls: 0, ms: 0};
        row.calls++;
        row.ms += performance.now() - started;
      }
    };
  }
  syncBuiltinESMExports();
}
export default function (pi) {
  let started;
  let runs;
  pi.on("session_start", () => {
    counters = {};
    active = true;
    started = performance.now();
  });
  agents({...pi, registerTool(tool) {
    if (tool.name === "agent_runs") runs = tool;
    pi.registerTool(tool);
  }});
  pi.on("session_start", (_event, ctx) => {
    const ms = performance.now() - started;
    active = false;
    emit({type: "perf_attach", owner: ctx.sessionManager.getSessionId(), ms, counters});
  });
  pi.registerCommand("perf-list", {description: "Synthetic benchmark only", handler: async (_args, ctx) => {
    const before = performance.now();
    const result = await runs.execute("synthetic-first-list", {action: "list"}, undefined, undefined, ctx);
    emit({type: "perf_list", ms: performance.now() - before, details: result.details});
  }});
  pi.registerCommand("perf-quit", {description: "Exit this isolated probe", handler: async (_args, ctx) => {ctx.shutdown();}});
}
'''

def fixture(root, sdk, repo, count):
    project = root / "project"
    agent = root / "agent"
    for directory in (project, agent, root / "home", root / "tmp"):
        directory.mkdir(parents=True, exist_ok=True)
    owner = "synthetic-owner-248"
    target = root / "synthetic.jsonl"
    header = dict(type="session", version=3, id=owner, cwd=str(project), timestamp="2026-10-24T00:00:00.000Z")
    rows = [header]
    parent = None
    for i in range(5180):
        entry_id = f"{i:08x}"
        common = dict(id=entry_id, parentId=parent, timestamp="2026-10-24T00:00:00.000Z")
        if i < count:
            rows.append(dict(common, type="custom_message", customType="agent-completion", content=f"Synthetic completed run {i}", display=True, details=dict(owner=owner, id=f"run-{i}", completed=True)))
        else:
            rows.append(dict(common, type="message", message=dict(role="user", content="Synthetic public padding " + "x" * 9950, timestamp=i)))
        parent = entry_id
    target.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))
    base = agent / "sessions" / "agent-runs" / owner
    for i in range(count):
        run_id = f"run-{i}"
        directory = base / run_id
        directory.mkdir(parents=True)
        launch = dict(version=1, id=run_id, rootId=run_id, owner=owner, cwd=str(project), agentDir=str(agent), sdk=str(sdk / "dist/index.js"), entry=str(repo / "dist/index.js"), sessionFile=str(root / "unused-child.jsonl"), sessionId=f"child-{i}", prompt="Synthetic task", context="fresh", provider="synthetic", model="none", thinking="off", trusted=False, createdAt=i)
        (directory / "launch.json").write_text(json.dumps(launch) + "\n")
        (directory / "result.json").write_text(json.dumps(dict(id=run_id, owner=owner, status="completed", endedAt=i+1, contributions=[])) + "\n")
    (root / "observer.mjs").write_text(OBSERVER)
    return project, agent, target, base


def sample(root, repo, sdk, profile=False, count=1000):
    root.mkdir(parents=True, exist_ok=False)
    project, agent, target, base = fixture(root, sdk, repo, count)
    manifest = json.loads((sdk / "package.json").read_text())
    cli = sdk / manifest["bin"]["pi"]
    env = {key: os.environ[key] for key in ("PATH", "LANG") if key in os.environ}
    env.update(HOME=str(root / "home"), TMPDIR=str(root / "tmp"), PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_TELEMETRY="0", PI_SUBAGENT_TEMP_ROOT=str(root / "pi-subagents-runtime"), BENCH_REPO=str(repo), BENCH_PROFILE="1" if profile else "0")
    command = ["node"]
    if profile:
        command += ["--cpu-prof", "--cpu-prof-dir=" + str(root)]
    command += [str(cli), "--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--approve", "--offline", "--tools", "delegate,agent_runs", "-e", str(root / "observer.mjs")]
    (root / "command.json").write_text(json.dumps(dict(argv=command, env=env), indent=2))
    with (root / "stderr.log").open("wb") as err, (root / "rpc.jsonl").open("w") as transcript, (root / "requests.jsonl").open("w") as requests:
        proc = subprocess.Popen(command, cwd=project, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        buffer = b""
        records = []
        def wait(predicate, timeout=30):
            nonlocal buffer
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                ready = selector.select(max(0, until - time.monotonic()))
                if not ready:
                    break
                block = os.read(proc.stdout.fileno(), 65536)
                if not block:
                    raise RuntimeError(f"CLI exited {proc.poll()}; see {root}/stderr.log")
                buffer += block
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    transcript.write(line.decode() + "\n")
                    transcript.flush()
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    records.append(record)
                    if record.get("type") == "extension_error":
                        raise RuntimeError(record)
                    if predicate(record):
                        return record
            raise TimeoutError(f"no expected CLI response in {root}")
        def send(kind, request_id, **kwargs):
            value = dict(type=kind, id=request_id, **kwargs)
            line = json.dumps(value) + "\n"
            requests.write(line)
            requests.flush()
            proc.stdin.write(line.encode())
            proc.stdin.flush()
        try:
            wait(lambda row: row.get("type") == "perf_attach")
            send("get_state", "ready")
            assert wait(lambda row: row.get("id") == "ready")["success"] is True
            start = time.perf_counter()
            send("switch_session", "switch", sessionPath=str(target))
            switched = wait(lambda row: row.get("id") == "switch")
            switch_ms = (time.perf_counter() - start) * 1000
            assert switched["success"] is True and switched["data"]["cancelled"] is False, switched
            send("get_state", "responsive")
            state = wait(lambda row: row.get("id") == "responsive")
            responsive_ms = (time.perf_counter() - start) * 1000
            assert state["success"] is True and state["data"]["sessionId"] == "synthetic-owner-248", state
            attachment = json.loads((base / "attachment.json").read_text())
            assert attachment["attached"] is True and attachment["pid"] == proc.pid, attachment
            send("prompt", "list", message="/perf-list")
            listed = wait(lambda row: row.get("type") == "perf_list")
            first_tool_ready_ms = (time.perf_counter() - start) * 1000
            assert listed["details"]["total"] == count
            assert len(listed["details"]["runs"]) == min(50, count)
            if count > 50:
                assert listed["details"]["nextOffset"] == 50
            time.sleep(.25)
            send("get_state", "after-timer")
            assert wait(lambda row: row.get("id") == "after-timer")["success"] is True
            send("prompt", "quit", message="/perf-quit")
            proc.wait(timeout=15)
            assert proc.returncode == 0
            assert json.loads((base / "attachment.json").read_text())["attached"] is False
            attaches = [row for row in records if row.get("type") == "perf_attach" and row.get("owner") == "synthetic-owner-248"]
            assert len(attaches) >= 1, attaches
            result = dict(repo=str(repo), sdk=str(sdk), version=manifest["version"], cliSha256=hashlib.sha256(cli.read_bytes()).hexdigest(), sessionBytes=target.stat().st_size, entries=5180, runCount=count, errors=0, switches=1, listRows=len(listed["details"]["runs"]), total=listed["details"]["total"], switchMs=switch_ms, responsiveMs=responsive_ms, attachMs=sum(row["ms"] for row in attaches), attachEvents=attaches, firstListMs=listed["ms"], firstToolReadyMs=first_tool_ready_ms, profile=profile)
            (root / "result.json").write_text(json.dumps(result, indent=2))
            return result
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            selector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("sdk", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--count", type=int, default=1000)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    for n in range(args.rounds):
        for label, repo in (("A", args.baseline), ("B", args.candidate)):
            row = sample(args.output / f"{n}-{label}", repo.resolve(), args.sdk.resolve(), args.profile, args.count)
            row.update(label=label, round=n)
            rows.append(row)
            print(json.dumps(row), flush=True)
    (args.output / "samples.json").write_text(json.dumps(rows, indent=2))
    summary = {}
    for label in ("A", "B"):
        chosen = [row for row in rows if row["label"] == label]
        summary[label] = {key: dict(median=statistics.median(row[key] for row in chosen), minimum=min(row[key] for row in chosen), maximum=max(row[key] for row in chosen)) for key in ("switchMs", "responsiveMs", "attachMs", "firstListMs", "firstToolReadyMs")}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
