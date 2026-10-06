import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// After setOwner admits <runId> first, hold the history worker synchronously at one native phase
// until the parent writes to fd 4: "admission:<runId>" at the metadata-root watch, after the
// database writes and before the reply; "changed:<runId>" at the next change publication, before
// its IPC write. The entered witness also uses fd 4, keeping the history IPC protocol unchanged.
const [phase, marker] = process.argv[3].split(":"), send = process.send.bind(process);
let armed = false;
process.on("message", (request) => {
	if (request?.method === "setOwner" && request.input?.runs?.[0]?.runId === marker) armed = true;
});
function hold() {
	armed = false;
	fs.writeSync(4, "E");
	const byte = Buffer.alloc(1);
	for (;;) {
		try {
			if (fs.readSync(4, byte, 0, 1, null) !== 1 || byte[0] !== 1) throw new Error("History gate closed without release.");
			return;
		} catch (error) {
			if (error.code !== "EAGAIN") throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
}
if (phase === "admission") {
	const watch = fs.watch;
	fs.watch = function(directory, ...args) {
		if (armed && String(directory).endsWith("/sessions/subagent-runs")) hold();
		return watch.call(this, directory, ...args);
	};
	syncBuiltinESMExports();
} else {
	process.send = function(message, ...args) {
		if (armed && message?.changed) hold();
		return send(message, ...args);
	};
}
