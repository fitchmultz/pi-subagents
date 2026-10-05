#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { boundaryOverrides, mutationBoundaries } from "./quality-boundaries.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const codePattern = /\.(?:[cm]?[jt]sx?)$/;

export function maintainedFiles(directory = root) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: directory,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => codePattern.test(file) && !file.startsWith("dist/"));
}

export function projectScope(directory = root) {
  const configPath = resolve(directory, "tsconfig.json");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const project = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
  if (project.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(project.errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => directory,
        getNewLine: () => "\n",
      }),
    );
  }
  return project;
}

export function typeProjects(directory = root) {
  const paths = new Set(
    maintainedFiles(directory).map((file) =>
      ts.findConfigFile(dirname(resolve(directory, file)), ts.sys.fileExists),
    ),
  );
  if (paths.has(undefined)) {
    throw new Error("Every maintained code file needs a type-resolution project");
  }
  return [...paths].sort().map((path) => ({ path, project: projectScope(dirname(path)) }));
}

export function scopedOverrides(config, directory = root) {
  const ownerFiles = new Set(mutationBoundaries.map((boundary) => boundary.file));
  const overrides = config.overrides.slice(0, -1).flatMap((override) => {
    if (
      override.files.every((file) => !/[*?{]/u.test(file) && !existsSync(resolve(directory, file)))
    ) {
      return [];
    }
    if (override.files.length !== 1 || !ownerFiles.has(override.files[0])) {
      return [override];
    }
    const rules = { ...override.rules };
    delete rules["no-param-reassign"];
    delete rules["typescript/prefer-readonly-parameter-types"];
    if (
      mutationBoundaries.some(
        (boundary) =>
          boundary.file === override.files[0] && boundary.argumentPresence !== undefined,
      )
    ) {
      delete rules["unicorn/no-useless-undefined"];
    }
    return Object.keys(rules).length === 0 ? [] : [{ ...override, rules }];
  });
  return [
    ...overrides,
    ...boundaryOverrides(config),
    { files: uncheckedJavaScript(directory), rules: uncheckedRules() },
  ];
}

export function uncheckedJavaScript(directory = root) {
  const files = maintainedFiles(directory);
  const configs = new Map();
  return files
    .filter((file) => {
      if (!/\.[cm]?jsx?$/.test(file)) {
        return false;
      }
      const path = resolve(directory, file);
      const config = ts.findConfigFile(dirname(path), ts.sys.fileExists);
      if (config === undefined) {
        throw new Error(`Maintained JavaScript lacks a TypeScript project: ${file}`);
      }
      if (!configs.has(config)) {
        configs.set(config, projectScope(dirname(config)));
      }
      const project = configs.get(config);
      if (!project.fileNames.includes(path)) {
        throw new Error(
          `Maintained JavaScript is absent from its type-resolution project: ${file}`,
        );
      }
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      if (source.checkJsDirective?.enabled === false) {
        throw new Error(`Forbidden @ts-nocheck: ${file}`);
      }
      return !(source.checkJsDirective?.enabled ?? project.options.checkJs ?? false);
    })
    .sort();
}

export function installedRules() {
  return JSON.parse(
    execFileSync(resolve(root, "node_modules/.bin/oxlint"), ["--rules", "--format=json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

export function uncheckedRules() {
  const result = Object.fromEntries(
    installedRules()
      .filter((rule) => rule.type_aware)
      .map((rule) => [`${rule.scope}/${rule.value}`, "off"]),
  );
  // JavaScript cannot express TS module-boundary annotations or type import syntax.
  result["typescript/explicit-module-boundary-types"] = "off";
  result["typescript/consistent-type-imports"] = "off";
  result["typescript/consistent-type-exports"] = "off";
  return result;
}

export function checkScope(directory = root) {
  checkBoundaryDeclarations(directory);
  const project = projectScope(directory);
  if (project.options.strict !== true || project.options.noImplicitReturns !== true) {
    throw new Error("Compiler policy requires strict and noImplicitReturns");
  }
  const missing = maintainedFiles(directory).filter(
    (file) => !project.fileNames.includes(resolve(directory, file)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Maintained code missing from compiler/type-resolution project: ${missing.join(", ")}`,
    );
  }
  checkLeafProjects(directory);
  const config = JSON.parse(readFileSync(resolve(directory, ".oxlintrc.json"), "utf8"));
  if (JSON.stringify(config.overrides) !== JSON.stringify(scopedOverrides(config, directory))) {
    throw new Error(
      "Owner or language scope is stale; run npm run quality:scope -- --write and review the diff",
    );
  }
  const actual = config.overrides.at(-1);
  return { maintained: maintainedFiles(directory).length, unchecked: actual.files.length };
}

function checkBoundaryDeclarations(directory) {
  const names = new Map();
  for (const boundary of mutationBoundaries) {
    if (!existsSync(resolve(directory, boundary.file))) {
      throw new Error(`Mutation boundary does not exist: ${boundary.file}`);
    }
    for (const type of boundary.types.filter((entry) => entry.from === "file")) {
      checkDeclaredType(directory, type, names);
    }
  }
  const config = JSON.parse(readFileSync(resolve(directory, ".oxlintrc.json"), "utf8"));
  for (const type of config.rules["typescript/prefer-readonly-parameter-types"][1].allow.filter(
    (entry) => entry.from === "file",
  )) {
    checkDeclaredType(directory, type, names);
  }
}

function checkDeclaredType(directory, type, names) {
  const path = resolve(directory, type.path);
  if (!names.has(path)) {
    if (!existsSync(path)) {
      throw new Error(`Qualified readonly origin does not exist: ${type.path}`);
    }
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations = new Map();
    function visit(node) {
      if (
        (ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)) &&
        node.name !== undefined
      ) {
        declarations.set(node.name.text, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    names.set(path, declarations);
  }
  for (const name of [type.name].flat()) {
    const declaration = names.get(path).get(name);
    if (declaration === undefined) {
      throw new Error(`Qualified readonly declaration does not exist: ${type.path}#${name}`);
    }
    if (ts.isTypeAliasDeclaration(declaration) && declaration.typeParameters?.length > 0) {
      throw new Error(
        `Generic readonly alias is not an approved fixed contract: ${type.path}#${name}`,
      );
    }
  }
}

function checkLeafProjects(directory) {
  for (const { path, project: leaf } of typeProjects(directory)) {
    if (
      leaf.options.strict !== true ||
      leaf.options.noImplicitReturns !== true ||
      leaf.options.noCheck === true
    ) {
      throw new Error(`Maintained leaf project weakens compiler policy: ${path}`);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/quality-scope.mjs [--write]\nVerify all maintained code and installed metadata-derived unchecked JS scope.\n--write refreshes the final override; review and commit it. Exit 1 on drift.\nExample: npm run quality:scope -- --write",
    );
  } else {
    if (args.some((arg) => arg !== "--write")) {
      throw new Error("Unknown scope option; use --help");
    }
    if (args.includes("--write")) {
      const path = resolve(root, ".oxlintrc.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.overrides = scopedOverrides(config);
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    }
    console.log("Quality scope:", checkScope());
  }
}
