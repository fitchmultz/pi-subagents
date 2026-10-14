import { useFakeTimers } from "sinon";

// Control only the helper's presence/startup clocks; native Pi and AbortSignal keep real clocks.
const clock = useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
let advancing = Promise.resolve();
function advance(milliseconds: number): void {
  advancing = advancing
    .then(async () => {
      await clock.tickAsync(milliseconds);
      process.stdout.write(`${JSON.stringify({ event: "fixture_clock", result: "advanced" })}\n`);
      return;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
process.on("SIGUSR2", () => advance(300001));
process.on("SIGALRM", () => advance(12001));
process.on("SIGUSR1", () => advance(119999));
const fetch = globalThis.fetch;
globalThis.fetch = (...args: Parameters<typeof fetch>) => {
  process.stdout.write(`${JSON.stringify({ event: "fixture_fetch", timestamp: Date.now() })}\n`);
  return fetch(...args);
};
await import("../../src/pi-intercom/bridge.ts");
