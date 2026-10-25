import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const originalRename = fsPromises.rename;
const originalRm = fsPromises.rm;

// Faults target only this build's staging-to-dist rename, never retiring or restoring dist.
function failPublish(fault) {
  fsPromises.rename = async (...args) =>
    /^dist\.staging\.\d+$/.test(basename(String(args[0])))
      ? fault(...args)
      : originalRename(...args);
}

const faults = {
  "stale-rm"() {
    const locked = (path) => basename(String(path)) === process.env.LOCKED_STAGING_NAME;
    fsPromises.rm = async (path, options) => {
      if (locked(path)) {
        throw new Error("synthetic stale-staging lock");
      }
      return originalRm(path, options);
    };
    fsPromises.rename = async (from, to) => {
      if (locked(from)) {
        throw new Error("synthetic stale-staging lock");
      }
      return originalRename(from, to);
    };
  },
  "late-winner"() {
    let firstRename = true;
    failPublish(async (...args) => {
      if (!firstRename) {
        return originalRename(...args);
      }
      firstRename = false;
      // The ref'd timer keeps the child alive so its marker proves publication
      // happened after the old two-second poll window.
      setTimeout(() => {
        fs.mkdirSync(join(process.cwd(), "dist"), { recursive: true });
        fs.writeFileSync(join(process.cwd(), "dist", "late-winner.txt"), "published");
      }, 2_200);
      throw new Error("synthetic late-winner race");
    });
  },
  "race-loss"() {
    failPublish(async () => {
      const cwd = process.cwd();
      const dist = join(cwd, "dist");
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(join(dist, "winner.txt"), "published");
      fs.writeFileSync(join(dist, "index.js"), "winner");
      throw new Error("synthetic race loss");
    });
  },
  "rename-always"() {
    failPublish(async () => {
      throw new Error("synthetic permanent rename failure");
    });
  },
  "vanish-staging"() {
    failPublish(async (...args) => {
      await originalRm(args[0], { force: true, recursive: true });
      return originalRename(...args);
    });
  },
  "empty-dist"() {
    let firstRename = true;
    failPublish(async (...args) => {
      const dist = join(process.cwd(), "dist");
      if (firstRename) {
        firstRename = false;
        fs.mkdirSync(dist, { recursive: true });
        throw new Error("synthetic empty dist");
      }
      fs.rmSync(dist, { recursive: true, force: true });
      return originalRename(...args);
    });
  },
};

const faultName = process.env.BUILD_SWAP_FAULT;
if (faultName && !Object.hasOwn(faults, faultName)) {
  throw new Error(`unknown build-swap fault: ${faultName}`);
}
faults[faultName]?.();
syncBuiltinESMExports();
