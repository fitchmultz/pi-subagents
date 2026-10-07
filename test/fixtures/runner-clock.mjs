import fs from "node:fs";
import { mock } from "node:test";
import { performance } from "node:perf_hooks";

// Only the private runner uses virtual time; MockPi clears NODE_OPTIONS for its real children.
const clockFile = process.env.PI_TEST_RUNNER_CLOCK;
if (clockFile && /subagent-runner\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  const interval = globalThis.setInterval;
  let sequence = 0;
  let resumedAt;
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const pump = interval(() => {
    if (resumedAt !== undefined) {
      const now = performance.now();
      // Reset would erase the runner's deadline/control timers, preventing cooperative cancel.
      mock.timers.tick(now - resumedAt);
      resumedAt = now;
    }
    if (!fs.existsSync(clockFile)) {
      return;
    }
    const command = JSON.parse(fs.readFileSync(clockFile, "utf8"));
    if (command.sequence <= sequence) {
      return;
    }
    sequence = command.sequence;
    if (command.resume) {
      resumedAt = performance.now();
    } else {
      mock.timers.tick(command.tick);
    }
    fs.writeFileSync(`${clockFile}.ack.tmp`, JSON.stringify({ sequence, now: Date.now() }));
    fs.renameSync(`${clockFile}.ack.tmp`, `${clockFile}.ack`);
  }, 5);
  pump.unref();
}
