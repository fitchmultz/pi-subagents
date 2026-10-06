import { readFileSync } from "node:fs";
import { nativeSnapshot } from "./compat-process-darwin-native.mjs";

try {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 8192) {
    throw new Error("Native query request exceeded its bound");
  }
  const snapshot = nativeSnapshot(JSON.parse(input));
  const output = JSON.stringify(snapshot);
  if (Buffer.byteLength(output) > 1024 * 1024) {
    throw new Error("Native query response exceeded its bound");
  }
  process.stdout.write(output);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
