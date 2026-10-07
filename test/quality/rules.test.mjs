import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, lint, put, remove } from "./probe-support.mjs";

// These fixtures test diagnostic behavior at the installed CLI, not schema acceptance.
const cases = [
  [
    "typescript/no-explicit-any",
    "export function f(...x: any[]) { return x; }",
    "export function f(x: unknown) { return x; }",
  ],
  [
    "typescript/no-non-null-assertion",
    "export const x = (null as string | null)!;",
    "export const x: string | null = null;",
  ],
  [
    "typescript/no-unsafe-type-assertion",
    "export function f(x: unknown) { return x as string; }",
    "export function f(x: unknown) { return typeof x === 'string' ? x : ''; }",
  ],
  [
    "typescript/no-unnecessary-type-assertion",
    "export const x = 1 as const;",
    "export const x = {a: 1} as const;",
  ],
  [
    "typescript/consistent-type-assertions",
    "export const x = {} as {a?: string};",
    "export const x: {a?: string} = {};",
  ],
  [
    "typescript/no-unsafe-argument",
    "declare const x: any; function f(x: string) {return x;} f(x);",
    "function f(x: string) {return x;} f('x');",
  ],
  [
    "typescript/no-unsafe-assignment",
    "declare const x: any; export const y: string = x;",
    "export const y: string = 'x';",
  ],
  ["typescript/no-unsafe-call", "declare const x: any; x();", "function x() {} x();"],
  [
    "typescript/no-unsafe-member-access",
    "declare const x: any; export const y = x.member;",
    "export const y = {member:1}.member;",
  ],
  [
    "typescript/no-unsafe-return",
    "declare const x: any; export function f(): string {return x;}",
    "export function f(): string {return 'x';}",
  ],
  ["typescript/no-empty-object-type", "export type T = {};", "export type T = object;"],
  [
    "typescript/no-unsafe-function-type",
    "export type T = Function;",
    "export type T = () => void;",
  ],
  ["typescript/no-wrapper-object-types", "export type T = String;", "export type T = string;"],
  [
    "typescript/no-invalid-void-type",
    "export const x: void = undefined;",
    "export function f(this: void): Promise<void> {return Promise.resolve();}",
  ],
  [
    "typescript/no-unnecessary-type-parameters",
    "export function f<T>(x: T): void {}",
    "export function f<T>(x: T): T {return x;}",
  ],
  [
    "typescript/no-deprecated",
    "/** @deprecated old */\nfunction old() {}\nold();",
    "function current() {} current();",
  ],
  [
    "typescript/unbound-method",
    "class A { method() {} } export const fn = new A().method;",
    "class A { method(this: void) {} } export const fn = new A().method;",
  ],
  [
    "typescript/no-misused-spread",
    "export const x = {...Promise.resolve(1)};",
    "export const x = {...{a:1}};",
  ],
  [
    "typescript/no-for-in-array",
    "for (const x in ['a']) {console.log(x);}",
    "for (const x of ['a']) {console.log(x);}",
  ],
  ["typescript/require-array-sort-compare", "[1,2].sort();", "[1,2].sort((a,b) => a-b);"],
  [
    "typescript/ban-ts-comment",
    "// @ts-ignore\nexport const x = 1;",
    "// @ts-check\nexport const x = 1;",
  ],
  [
    "typescript/strict-boolean-expressions",
    "export function f(x: string) {if(x) {return 1;} return 0;}",
    "export function f(x: object | null) {if(x) {return 1;} return 0;}",
  ],
  [
    "typescript/no-unnecessary-condition",
    "export function f(x: string) {if(x !== undefined) {return x;} return '';}",
    "while (true) {break;}",
  ],
  [
    "typescript/switch-exhaustiveness-check",
    "export function f(x:'a'|'b') {switch(x) {case 'a':return 1; default:return 0;}}",
    "export function f(x:'a'|'b') {switch(x) {case 'a':return 1;case 'b':return 2;}}",
  ],
  ["eqeqeq", "export const x = 1 == '1';", "export const x = 1 === 1;"],
  [
    "no-implicit-coercion",
    "export function f(x: unknown) {return !!x;}",
    "export function f(x: unknown) {return Boolean(x);}",
  ],
  [
    "typescript/restrict-plus-operands",
    "export function f(x: string) {return x + 1;}",
    "export function f(x: number) {return x + 1;}",
  ],
  [
    "typescript/restrict-template-expressions",
    "export function f(x: null) {return `${x}`;}",
    "export function f(x: number) {return `${x}`;}",
  ],
  [
    "typescript/no-base-to-string",
    "export function f(x: unknown) {return String(x);}",
    "export function f(x: string) {return String(x);}",
  ],
  ["typescript/no-floating-promises", "void Promise.resolve();", "await Promise.resolve();"],
  ["typescript/no-misused-promises", "setTimeout(async () => {}, 1);", "setTimeout(() => {}, 1);"],
  ["typescript/await-thenable", "await 1;", "await Promise.resolve(1);"],
  [
    "typescript/return-await",
    "export async function f() {try {return Promise.resolve(1);} catch {return 0;}}",
    "export async function f() {try {return await Promise.resolve(1);} catch {return 0;}}",
  ],
  [
    "typescript/strict-void-return",
    "export const f: () => void = () => 1;",
    "export const f: () => void = () => {};",
  ],
  [
    "typescript/no-confusing-void-expression",
    "function f():void {} export const x = f();",
    "function f():void {} export const x = () => f();",
  ],
  ["typescript/no-meaningless-void-operator", "void console.log('a');", "void Promise.resolve();"],
  [
    "promise/always-return",
    "Promise.resolve(1).then((x) => { if(x) {return x;} }).then(console.log);",
    "Promise.resolve(1).then((x) => {console.log(x);});",
  ],
  [
    "promise/catch-or-return",
    "Promise.resolve(1).then(console.log);",
    "Promise.resolve(1).then(console.log).catch(console.error);",
  ],
  [
    "no-await-in-loop",
    "for (const x of [1]) {await Promise.resolve(x);}",
    "await Promise.all([1].map((x) => Promise.resolve(x)));",
  ],
  [
    "typescript/only-throw-error",
    "throw 'bad';",
    "try {throw new Error('bad');} catch (error) {throw error;}",
  ],
  [
    "typescript/use-unknown-in-catch-callback-variable",
    "Promise.resolve().catch((error) => {console.log(error);});",
    "Promise.resolve().catch((error: unknown) => {console.log(error);});",
  ],
  [
    "typescript/prefer-promise-reject-errors",
    "Promise.reject();",
    "Promise.reject(new Error('bad'));",
  ],
  [
    "no-useless-catch",
    "try {console.log(1);} catch(error) {throw error;}",
    "try {console.log(1);} catch(error) {console.error(error);}",
  ],
  [
    "no-param-reassign",
    "export function f(x: {value:number}) {x.value = 1;}",
    "export function f(x: {value:number}) {return {...x,value:1};}",
  ],
  [
    "typescript/prefer-readonly",
    "export class A {private value = 1; get() {return this.value;}}",
    "export class A {private readonly value = 1; get() {return this.value;}}",
  ],
  [
    "typescript/prefer-readonly-parameter-types",
    "export function f(x: {value:string}) {return x.value;}",
    "export function f(x: {readonly value:string}) {return x.value;}",
  ],
  [
    "typescript/explicit-module-boundary-types",
    "export function f() {return 1;}",
    "export function f(): number {return 1;}",
  ],
  [
    "typescript/method-signature-style",
    "export interface A {f():void;}",
    "export interface A {f: () => void;}",
  ],
  [
    "typescript/consistent-type-imports",
    "export type A = import('node:net').Socket;",
    "import type {Socket} from 'node:net'; export type A = Socket;",
  ],
  [
    "typescript/consistent-type-exports",
    "import type {Socket} from 'node:net'; export {Socket};",
    "import type {Socket} from 'node:net'; export type {Socket};",
  ],
  [
    "typescript/no-import-type-side-effects",
    "import {type Socket} from 'node:net'; export type A=Socket;",
    "import type {Socket} from 'node:net'; export type A=Socket;",
  ],
  ["import/no-self-import", "import './main.js';", "import 'node:fs';"],
  [
    "import/no-duplicates",
    "import {readFileSync} from 'node:fs'; import {writeFileSync} from 'node:fs'; console.log(readFileSync,writeFileSync);",
    "import {readFileSync,writeFileSync} from 'node:fs'; console.log(readFileSync,writeFileSync);",
  ],
  ["import/no-mutable-exports", "export let value = 1;", "export const value = 1;"],
  ["curly", "if (true) console.log(1);", "if (true) {console.log(1);}"],
  ["no-var", "var value = 1; console.log(value);", "const value = 1; console.log(value);"],
  ["prefer-const", "let value = 1; console.log(value);", "const value = 1; console.log(value);"],
  [
    "no-nested-ternary",
    "export const x = true ? 1 : false ? 2 : 3;",
    "export const x = true ? 1 : 2;",
  ],
  [
    "no-return-assign",
    "export function f() {let x=1;return (x=2);}",
    "export function f() {let x=1;x=2;return x;}",
  ],
  ["no-sequences", "let x=1,y=2; x++, y++;", "export const x = 2;"],
  ["no-multi-assign", "let x, y; x = y = 1;", "let x, y; x = 1; y = 1;"],
  [
    "no-else-return",
    "export function f(x: boolean) {if(x) {return 1;} else {return 0;}}",
    "export function f(x: boolean) {if(x) {return 1;} return 0;}",
  ],
  ["no-eval", "eval('1');", "Number('1');"],
  ["no-implied-eval", "setTimeout('run()', 1);", "setTimeout(() => {}, 1);"],
  ["no-new-func", "new Function('return 1');", "() => 1;"],
  ["no-debugger", "debugger;", "console.log(1);"],
  ["no-control-regex", "export const x = /[\\u0000-\\u001f]/u;", "export const x = /[a-z]/u;"],
  [
    "no-empty",
    "try {console.log(1);} catch {}",
    "try {console.log(1);} catch {console.error('failed');}",
  ],
  [
    "no-empty-function",
    "export function f() {}",
    "export function f() { /* This intentional sink stores nothing. */ }",
  ],
  [
    "unicorn/no-useless-undefined",
    "export function f() {return undefined;}",
    "export function f() {return;}",
  ],
];

await test("each selected rule reports the intended violation and preserves its valid boundary", async (t) => {
  const dir = fixture();
  try {
    for (const [rule, bad, good] of cases) {
      // Each probe rewrites the same disposable file; serialization prevents fixture races.
      // oxlint-disable-next-line no-await-in-loop
      await t.test(rule, () => {
        put(dir, "main.ts", `export {};\n${bad}\n`);
        const invalid = lint(dir, [rule]);
        assert.ok(invalid.length > 0, `${rule} failed to detect negative fixture`);
        assert.ok(
          invalid.every(
            (entry) => entry.rule === rule && entry.file === "main.ts" && entry.line >= 2,
          ),
        );
        put(dir, "main.ts", `export {};\n${good}\n`);
        assert.deepEqual(lint(dir, [rule]), [], `${rule} rejected valid boundary`);
      });
    }
  } finally {
    remove(dir);
  }
});

await test("production structural limits retain independent failure boundaries", () => {
  const dir = fixture();
  try {
    const metrics = [
      [
        "complexity",
        `export function f(x:number) {${Array.from({ length: 11 }, (_, i) => `if(x===${i}) {console.log(x);}`).join("\n")}}`,
      ],
      [
        "max-depth",
        "export function f(x:boolean) {if(x) {if(x) {if(x) {if(x) {console.log(x);}}}}}",
      ],
      [
        "max-params",
        "export function f(a:number,b:number,c:number,d:number,e:number) {return a+b+c+d+e;}",
      ],
      [
        "max-statements",
        `export function f() {${Array.from({ length: 41 }, () => "console.log(1);").join("\n")}}`,
      ],
      [
        "max-lines-per-function",
        `export function f() {\n${Array.from({ length: 81 }, () => "console.log(1);").join("\n")}\n}`,
      ],
      [
        "max-lines",
        Array.from({ length: 501 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
      ],
    ];
    for (const [rule, source] of metrics) {
      put(dir, "main.ts", source);
      assert.ok(
        lint(dir, [rule]).some((entry) => entry.rule === rule),
        rule,
      );
      put(dir, "main.ts", "export function f(): number {return 1;}");
      assert.deepEqual(lint(dir, [rule]), [], rule);
    }
  } finally {
    remove(dir);
  }
});
