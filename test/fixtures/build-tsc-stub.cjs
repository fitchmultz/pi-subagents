if (process.env.TSC_STUB_FAIL === "1") {
	console.error("stub-tsc: induced failure");
	process.exit(1);
}

const fs = require("node:fs");
const path = require("node:path");
const outDir = process.argv[process.argv.indexOf("--outDir") + 1];
fs.mkdirSync(path.join(outDir, "extension"), { recursive: true });
fs.writeFileSync(path.join(outDir, "extension", "build-info.js"), "export const EXTENSION_BUILD = {};\n");
fs.writeFileSync(path.join(outDir, "index.js"), `export const built = ${JSON.stringify(process.env.TSC_STUB_MARKER ?? true)};\n`);
