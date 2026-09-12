import fs from "node:fs";

// Hold only this private fixture runner's poll clock; children and broker stay live.
const release = process.env.PI_TEST_RUNNER_POLL_RELEASE;
if (release && /subagent-runner\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	const interval = globalThis.setInterval;
	globalThis.setInterval = (callback, milliseconds, ...args) => interval(() => {
		if (fs.existsSync(release)) callback(...args);
		else if (!fs.existsSync(`${release}.held`)) fs.writeFileSync(`${release}.held`, "poll deferred");
	}, milliseconds);
}
