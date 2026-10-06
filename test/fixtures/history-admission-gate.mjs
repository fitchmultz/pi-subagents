import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Hold one owner admission at its synchronous metadata-root watch, after its
// database writes and before its reply, until the parent writes to fd 4.
const marker = process.argv[3], watch = fs.watch;
let armed = false;
process.on("message", (request) => {
	if (request?.method === "setOwner" && request.input?.runs?.[0]?.runId === marker) armed = true;
});
fs.watch = function(directory, ...args) {
	if (armed && String(directory).endsWith("/sessions/subagent-runs")) {
		armed = false;
		process.send({ admissionGate: "entered" });
		const byte = Buffer.alloc(1);
		for (;;) {
			try {
				if (fs.readSync(4, byte, 0, 1, null) !== 1 || byte[0] !== 1) throw new Error("Admission gate closed without release.");
				break;
			} catch (error) {
				if (error.code !== "EAGAIN") throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
	}
	return watch.call(this, directory, ...args);
};
syncBuiltinESMExports();
