import { useFakeTimers } from "sinon";

// Control only the helper's presence/startup clocks; native Pi and AbortSignal keep real clocks.
const clock = useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
function advance(milliseconds: number): void {
  clock.tick(milliseconds);
  process.stdout.write(`${JSON.stringify({ event: "fixture_clock", result: "advanced" })}\n`);
}
process.on("SIGUSR2", () => advance(300001));
process.on("SIGALRM", () => advance(12001));
await import("../../src/pi-intercom/bridge.ts");
