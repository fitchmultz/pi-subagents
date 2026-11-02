import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
/** @type {typeof import("node:fs")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const fs = nodeRequire("node:fs");
/** @type {typeof import("node:fs/promises")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const fsPromises = nodeRequire("node:fs/promises");
const originalRename = fsPromises.rename;
const originalRm = fsPromises.rm;

// Faults target only this build's staging-to-dist rename, never retiring or restoring dist.
/**
 * @param {(...args: unknown[]) => Promise<unknown>} fault
 */
// oxlint-disable typescript/no-unsafe-type-assertion -- narrowing the fs overloads for spread calls
function failPublish(fault) {
  /** @param {unknown[]} args */
  const tracedRename = async (...args) =>
    typeof args[0] === "string" && /^dist\.staging\.\d+$/.test(basename(args[0]))
      ? fault(...args)
      : /** @type {(...a: unknown[]) => Promise<unknown>} */ (originalRename)(...args);
  fsPromises.rename = /** @type {typeof fsPromises.rename} */ (tracedRename);
}
// oxlint-enable typescript/no-unsafe-type-assertion

// oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- narrowing the fs overloads for spread calls
/** @type {Record<string, () => void>} */
const faults = {
  "stale-rm"() {
    const locked = (/** @type {import("node:fs").PathLike} */ path) =>
      basename(String(path)) === process.env.LOCKED_STAGING_NAME;
    /**
     * @param {import("node:fs").PathLike} path
     * @param {import("node:fs").RmOptions | undefined} options
     */
    const tracedRm = async (path, options) => {
      if (locked(path)) {
        throw new Error("synthetic stale-staging lock");
      }
      return /** @type {(p: import("node:fs").PathLike, o: import("node:fs").RmOptions | undefined) => Promise<void>} */ (
        originalRm
      )(path, options);
    };
    /**
     * @param {import("node:fs").PathLike} from
     * @param {import("node:fs").PathLike} to
     */
    const tracedStaleRename = async (from, to) => {
      if (locked(from)) {
        throw new Error("synthetic stale-staging lock");
      }
      return /** @type {(f: import("node:fs").PathLike, t: import("node:fs").PathLike) => Promise<void>} */ (
        originalRename
      )(from, to);
    };
    fsPromises.rm = /** @type {typeof fsPromises.rm} */ (tracedRm);
    fsPromises.rename = /** @type {typeof fsPromises.rename} */ (tracedStaleRename);
  },
  "late-winner"() {
    let firstRename = true;
    failPublish(async (...args) => {
      if (!firstRename) {
        return /** @type {(...a: unknown[]) => Promise<unknown>} */ (originalRename)(...args);
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
      await originalRm(/** @type {import("node:fs").PathLike} */ (args[0]), {
        force: true,
        recursive: true,
      });
      return /** @type {(...a: unknown[]) => Promise<unknown>} */ (originalRename)(...args);
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
      return /** @type {(...a: unknown[]) => Promise<unknown>} */ (originalRename)(...args);
    });
  },
};

const faultName = process.env.BUILD_SWAP_FAULT;
if (faultName !== undefined && !Object.hasOwn(faults, faultName)) {
  throw new Error(`unknown build-swap fault: ${faultName}`);
}
faults[faultName ?? ""]?.();
// oxlint-enable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion
syncBuiltinESMExports();
