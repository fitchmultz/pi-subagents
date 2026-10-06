import { useFakeTimers } from "sinon";

// Control only the helper's five-minute presence clock; native Pi children keep real clocks.
const clock = useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
process.on("SIGUSR2", () => {
  clock.tick(300001);
  process.stdout.write(`${JSON.stringify({ event: "fixture_clock", result: "advanced" })}\n`);
});
await import("../../src/pi-intercom/bridge.ts");
