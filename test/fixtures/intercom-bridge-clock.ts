import { useFakeTimers } from "sinon";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Control only the helper's presence/startup clocks; native Pi and AbortSignal keep real clocks.
const clockFile = process.env.PI_FIXTURE_CLOCK_FILE;
const now =
  clockFile !== undefined && existsSync(clockFile)
    ? Number(readFileSync(clockFile, "utf8"))
    : Date.now();
const clock = useFakeTimers({ now, toFake: ["Date", "setTimeout", "clearTimeout"] });
let advancing = Promise.resolve();
function advance(milliseconds: number): void {
  advancing = advancing
    .then(async () => {
      // Replaying every intermediate timer can expire Undici's connect timeout before real TLS I/O.
      if (clockFile !== undefined) {
        // Persist the advanced wall time before running callbacks, including injected SIGKILL.
        writeFileSync(clockFile, String(Date.now() + milliseconds));
      }
      clock.jump(milliseconds);
      await clock.tickAsync(0);
      process.stdout.write(
        `${JSON.stringify({ event: "fixture_clock", result: "advanced", timestamp: Date.now() })}\n`,
      );
      return;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
process.on("SIGWINCH", () => advance(2001));
process.on("SIGQUIT", () => advance(3600001));
let crashBeforeFetch = false;
process.on("SIGUSR2", () => {
  crashBeforeFetch = process.env.PI_FIXTURE_CRASH_BEFORE_FETCH === "1";
  advance(300001);
});
process.on("SIGALRM", () => advance(15001));
process.on("SIGUSR1", () => advance(119999));
const fetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  process.stdout.write(`${JSON.stringify({ event: "fixture_fetch", timestamp: Date.now() })}\n`);
  if (crashBeforeFetch) {
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {
      // SIGKILL owns termination; do not let the original transport dispatch.
    });
  }
  try {
    return await fetch(...args);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    console.error(
      JSON.stringify({
        event: "fixture_fetch_failed",
        error: cause instanceof Error ? cause.message : "Unknown fetch failure",
      }),
    );
    throw error;
  }
};
await import("../../src/pi-intercom/bridge.ts");
