import fs from "node:fs";
import { mock } from "node:test";

// Only the private runner uses virtual time; MockPi clears NODE_OPTIONS for its real children.
const clockFile = process.env.PI_TEST_RUNNER_CLOCK;
if (clockFile && /subagent-runner\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	const interval = globalThis.setInterval;
	let sequence = 0;
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
	const pump = interval(() => {
		if (!fs.existsSync(clockFile)) return;
		const command = JSON.parse(fs.readFileSync(clockFile, "utf8"));
		if (command.sequence <= sequence) return;
		sequence = command.sequence;
		if (command.resume) mock.timers.reset();
		else mock.timers.tick(command.tick);
		fs.writeFileSync(`${clockFile}.ack.tmp`, JSON.stringify({ sequence, now: Date.now() }));
		fs.renameSync(`${clockFile}.ack.tmp`, `${clockFile}.ack`);
	}, 5);
	pump.unref();
}
