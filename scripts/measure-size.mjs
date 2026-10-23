#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "scripts", "generated"];
const extensions = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".sh"]);
const ceilings = { sourceLines: 18000, productionLines: 22000, productionBytes: 1048576 };

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function files(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return await files(path);
      }
      return extensions.has(extname(path)) ? [path] : [];
    }),
  );
  return nested.flat();
}

/** @param {string} text */
function lineCount(text) {
  if (text === "") {
    return 0;
  }
  return text.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(text) ? 1 : 0);
}

const paths = (await Promise.all(roots.map(files))).flat().sort((a, b) => a.localeCompare(b));
const rows = await Promise.all(
  paths.map(async (path) => {
    const content = await readFile(path);
    return { path, lines: lineCount(content.toString("utf8")), bytes: content.byteLength };
  }),
);
const measured = {
  sourceLines: rows
    .filter((row) => row.path.startsWith("src/") && row.path.endsWith(".ts"))
    .reduce((total, row) => total + row.lines, 0),
  productionLines: rows.reduce((total, row) => total + row.lines, 0),
  productionBytes: rows.reduce((total, row) => total + row.bytes, 0),
};
console.log(JSON.stringify({ files: rows.length, measured, ceilings }, null, 2));
if (!process.argv.includes("--report")) {
  const exceeded = Object.keys(ceilings).filter((key) => measured[key] > ceilings[key]);
  if (exceeded.length > 0) {
    console.error(`Shrink budget exceeded: ${exceeded.join(", ")}`);
    process.exitCode = 1;
  }
}
