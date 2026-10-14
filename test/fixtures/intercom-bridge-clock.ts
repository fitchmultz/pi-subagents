import { useFakeTimers } from "sinon";

// Control only the helper's presence/startup clocks; native Pi and AbortSignal keep real clocks.
const clock = useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
let advancing = Promise.resolve();
function advance(milliseconds: number): void {
  advancing = advancing
    .then(async () => {
      // Replaying every intermediate timer can expire Undici's connect timeout before real TLS I/O.
      clock.jump(milliseconds);
      await clock.tickAsync(0);
      process.stdout.write(`${JSON.stringify({ event: "fixture_clock", result: "advanced" })}\n`);
      return;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
process.on("SIGUSR2", () => advance(300001));
process.on("SIGALRM", () => advance(15001));
process.on("SIGUSR1", () => advance(119999));
const fetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  process.stdout.write(`${JSON.stringify({ event: "fixture_fetch", timestamp: Date.now() })}\n`);
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
