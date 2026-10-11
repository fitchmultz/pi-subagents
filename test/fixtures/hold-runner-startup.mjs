import fs from "node:fs";

const release = process.env.PI_TEST_STARTUP_RELEASE;
if (release && /subagent-runner-launcher\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  fs.writeFileSync(`${release}.held`, "native launcher held before runner startup");
  const deadline = Date.now() + 15_000,
    clock = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) {
      throw new Error("startup fixture was not released");
    }
    Atomics.wait(clock, 0, 0, 10);
  }
}
