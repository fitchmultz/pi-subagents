#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { approvedScopedDirective } from "./quality-directives.mjs";
import { checkScope, maintainedFiles, root } from "./quality-scope.mjs";

const singleSiteRules = new Set([
  "no-await-in-loop",
  "no-control-regex",
  "typescript/prefer-readonly-parameter-types",
  "typescript/no-unnecessary-condition",
]);

function comments(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const ranges = new Map();
  function visit(node) {
    for (const position of [node.getFullStart(), node.getEnd()]) {
      const found = [
        ...(ts.getLeadingCommentRanges(source, position) ?? []),
        ...(ts.getTrailingCommentRanges(source, position) ?? []),
      ];
      for (const range of found) {
        ranges.set(range.pos, {
          text: source.slice(range.pos, range.end),
          line: parsed.getLineAndCharacterOfPosition(range.pos).line + 1,
        });
      }
    }
    for (const child of node.getChildren(parsed)) {
      visit(child);
    }
  }
  visit(parsed);
  return [...ranges.values()].sort((left, right) => left.line - right.line);
}

export function suppressionProblems(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = comments(source, file);
  const problems = [];
  for (const comment of found) {
    const directive = comment.text
      .replace(/^\/\/\/?\s*|^\/\*+\s*/u, "")
      .replace(/\*\/$/u, "")
      .trim();
    if (/^@ts-(?:ignore|nocheck)\b/mu.test(directive)) {
      problems.push(`${file}:${comment.line}: forbidden compiler suppression`);
    }
    if (
      /^@ts-expect-error\b/mu.test(directive) &&
      (!file.endsWith(".test-d.ts") || !/@ts-expect-error\s*:?\s*\S.{9}/.test(comment.text))
    ) {
      problems.push(
        `${file}:${comment.line}: expect-error requires a described dedicated .test-d.ts case`,
      );
    }
    if (
      /^(?:eslint|oxlint)-(?:disable|enable)\b/mu.test(directive) &&
      !approvedDirective(comment, found, parsed, file)
    ) {
      problems.push(
        `${file}:${comment.line}: only approved, explained single-rule next-line exceptions are permitted`,
      );
    }
  }
  return problems;
}

function approvedDirective(comment, found, parsed, file) {
  const match = /^\/\/\s*oxlint-disable-next-line\s+([\w/-]+)\s*$/.exec(comment.text);
  const explanation = found.find((candidate) => candidate.line === comment.line - 1);
  return (
    match !== null &&
    ((singleSiteRules.has(match[1]) &&
      (match[1] !== "typescript/prefer-readonly-parameter-types" ||
        genericCallback(parsed, comment.line + 1))) ||
      approvedScopedDirective(match[1], parsed, comment.line + 1, file)) &&
    explanation !== undefined &&
    explanation.text.length >= 25 &&
    !/\b(?:eslint|oxlint)-/.test(explanation.text)
  );
}

function genericCallback(source, line) {
  function visit(node) {
    if (
      ts.isParameter(node) &&
      node.type !== undefined &&
      ts.isFunctionTypeNode(node.type) &&
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === line &&
      ts.isTypeReferenceNode(node.type.type) &&
      ts.isIdentifier(node.type.type.typeName)
    ) {
      return (
        node.parent.typeParameters?.some(
          (parameter) => parameter.name.text === node.type.type.typeName.text,
        ) === true
      );
    }
    return ts.forEachChild(node, visit) === true;
  }
  return visit(source);
}

function checkConfiguration(directory) {
  const config = JSON.parse(readFileSync(resolve(directory, ".oxlintrc.json"), "utf8"));
  for (const key of ["typeAware", "typeCheck", "denyWarnings"]) {
    if (config.options[key] !== true) {
      throw new Error(`Required Oxlint option disabled: ${key}`);
    }
  }
  if (
    config.options.reportUnusedDisableDirectives !== "error" ||
    config.options.respectEslintDisableDirectives !== false
  ) {
    throw new Error("Native suppression enforcement weakened");
  }
  for (const category of ["correctness", "suspicious", "perf"]) {
    if (config.categories[category] !== "error") {
      throw new Error(`Required category weakened: ${category}`);
    }
  }
  checkRequiredRules(config);
  checkPromisePolicy(config.rules["typescript/no-floating-promises"][1]);
  checkReadonlyPolicy(config.rules["typescript/prefer-readonly-parameter-types"][1]);
  if (
    JSON.stringify(config.ignorePatterns ?? []) !== JSON.stringify(["dist/**", "dist.staging*/**"])
  ) {
    throw new Error("Only build-owned output may be excluded from lint");
  }
}

function checkRequiredRules(config) {
  const required = {
    complexity: ["error", { max: 10, variant: "modified" }],
    "max-depth": ["error", { max: 3 }],
    "max-params": ["error", { max: 4 }],
    "max-statements": ["error", { max: 40 }],
    "max-lines-per-function": [
      "error",
      { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
    ],
    "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
    "no-param-reassign": ["error", { props: true }],
  };
  for (const [name, value] of Object.entries(required)) {
    if (JSON.stringify(config.rules[name]) !== JSON.stringify(value)) {
      throw new Error(`Required production contract changed: ${name}`);
    }
  }
  for (const name of [
    "require-await",
    "typescript/require-await",
    "typescript/consistent-return",
    "unicorn/no-array-sort",
    "unicorn/no-array-reverse",
  ]) {
    if (config.rules[name] !== "off") {
      throw new Error(`Deliberate policy exclusion changed: ${name}`);
    }
  }
}

function checkPromisePolicy(safe) {
  if (
    safe.ignoreVoid !== false ||
    safe.checkThenables !== true ||
    safe.ignoreIIFE !== false ||
    safe.allowForKnownSafePromises.length !== 0
  ) {
    throw new Error("Floating Promise policy weakened");
  }
}

function checkReadonlyPolicy(readonly) {
  if (
    readonly.ignoreInferredTypes !== true ||
    readonly.treatMethodsAsReadonly !== false ||
    readonly.checkParameterProperties !== true
  ) {
    throw new Error("Readonly contracts weakened");
  }
  for (const allowance of readonly.allow) {
    if (
      typeof allowance !== "object" ||
      !["lib", "package", "file"].includes(allowance.from) ||
      [allowance.name]
        .flat()
        .some((name) =>
          ["Map", "Set", "ReadonlyMap", "ReadonlySet", "Record", "Readonly"].includes(name),
        )
    ) {
      throw new Error("Unqualified or generic-container readonly allowance");
    }
  }
}

export function checkPolicy(directory = root) {
  checkScope(directory);
  checkConfiguration(directory);
  const problems = maintainedFiles(directory).flatMap((file) =>
    suppressionProblems(readFileSync(resolve(directory, file), "utf8"), file),
  );
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  console.log(
    "Quality policy: maintained code, compiler scope, configuration and comment directives verified",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node scripts/quality-policy.mjs\nCheck maintained scope, strict configuration and actual comment directives.\nExit 1 for unapproved/blanket compiler or lint suppressions.\nExample: npm run quality:policy",
    );
  } else if (process.argv.length > 2) {
    throw new Error("Unknown policy option; use --help");
  } else {
    checkPolicy();
  }
}
