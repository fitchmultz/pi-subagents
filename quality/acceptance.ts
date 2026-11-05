import { spawn } from "node:child_process";

const gates = [
  "lint",
  "format:check",
  "typecheck",
  "typecheck:declarations",
  "check:quality",
  "check:size",
  "smoke:package",
  "smoke:install",
  "test:unit",
  "test:integration",
];
const failures: string[] = [];
for (const gate of gates) {
  const status = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["run", gate], { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  console.log(`[acceptance] ${gate}: ${status === 0 ? "PASS" : "FAIL"} (${status})`);
  if (status !== 0) {
    failures.push(gate);
  }
}
if (failures.length > 0) {
  console.error(`Failed gates: ${failures.join(", ")}`);
  process.exitCode = 1;
}
