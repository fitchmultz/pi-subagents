import assert from "node:assert/strict";
import { test } from "node:test";
import { config, fixture, lint, put, remove, compiler } from "./probe-support.mjs";

await test("erased SDK aliases retain declaration identity through readonly and optional wrappers", () => {
  const dir = fixture();
  try {
    const alias =
      'import type {ToolResultMessage,AssistantMessage} from "@earendil-works/pi-ai"; export type RecordedToolResult=ToolResultMessage; export type UnionRecorded=ToolResultMessage | AssistantMessage;';
    put(dir, "owned/history-display.ts", alias);
    put(dir, "foreign/history-display.ts", alias);
    put(
      dir,
      "reexport.ts",
      'export type {RecordedToolResult as Routed} from "./owned/history-display.js";',
    );
    put(
      dir,
      "node_modules/quality-foreign-result/package.json",
      '{"name":"quality-foreign-result","types":"index.d.ts"}',
    );
    put(
      dir,
      "node_modules/quality-foreign-result/index.d.ts",
      'import type {ToolResultMessage} from "@earendil-works/pi-ai"; export type RecordedToolResult=ToolResultMessage<{values:string[]}>;',
    );
    put(
      dir,
      "main.ts",
      `import type {ToolResultMessage,AssistantMessage} from "@earendil-works/pi-ai";
import type {RecordedToolResult,RecordedToolResult as Renamed,UnionRecorded} from "./owned/history-display.js";
import type * as Native from "./owned/history-display.js";
import type {RecordedToolResult as Foreign,UnionRecorded as ForeignUnion} from "./foreign/history-display.js";
import type {RecordedToolResult as Packaged} from "quality-foreign-result";
import type {Routed} from "./reexport.js";
export function approved(value:RecordedToolResult){return value;}
export function renamed(value:Renamed){return value;}
export function namespace(value:Native.RecordedToolResult){return value;}
export function reexported(value:Routed){return value;}
export function foreign(value:Foreign){return value;}
export function packaged(value:Packaged){return value;}
{type RecordedToolResult=ToolResultMessage; function shadow(value:RecordedToolResult){return value;}}
export function mutablePayload(value:ToolResultMessage<{values:string[]}>){return value;}
export function mutableAttachment(value:RecordedToolResult & {values:string[]}){return value;}
export function readonlyAttachment(value:RecordedToolResult & {readonly labels:readonly string[]}){return value;}
export function unrelated(value:{values:string[]}){return value;}
export function nested(value:{readonly result:RecordedToolResult}){return value;}
export function nestedMutable(value:{readonly result:RecordedToolResult; readonly app:{values:string[]}}){return value;}
type Copy=RecordedToolResult;
export function copied(value:Copy){return value;}
type MutableCopy=RecordedToolResult & {values:string[]};
export function mutableCopy(value:MutableCopy){return value;}
export function maybe(value:RecordedToolResult | undefined){return value;}
export function noPermissionLeak(value:{readonly approved:RecordedToolResult & {readonly labels:readonly string[]}; readonly forbidden:ToolResultMessage}){return value;}
export function optionalNested(value:{readonly result?:RecordedToolResult}){return value;}
export function optionalMapped(value:Readonly<{result?:RecordedToolResult}>){return value;}
export function optionalHistory(value:readonly Readonly<Pick<{result?:RecordedToolResult},"result">>[]){return value;}
export function optionalMutable(value:{readonly result?:RecordedToolResult; readonly app?:{values:string[]}}){return value;}
export function optionalParameter(value?:RecordedToolResult){return value;}
export function optionalForeign(value:{readonly result?:Foreign}){return value;}
export function optionalUnion(value:{readonly message?:UnionRecorded}){return value;}
export function requiredUnion(value:{readonly message:UnionRecorded}){return value;}
export function mappedUnion(value:readonly Readonly<Pick<{message?:UnionRecorded},"message">>[]){return value;}
export function unionMutable(value:{readonly message?:UnionRecorded; readonly state:string[]}){return value;}
export function unapprovedUnion(value:{readonly message?:ToolResultMessage | AssistantMessage}){return value;}
{type UnionRecorded=ToolResultMessage | AssistantMessage; function unionShadow(value:{readonly message?:UnionRecorded}){return value;}}
export function foreignUnion(value:{readonly message?:ForeignUnion}){return value;}
export function mixedMutableUnion(value:{readonly message?:UnionRecorded | {readonly payload:string[]}}){return value;}
export function optionalMutableUnionAttachment(value:{readonly message?:UnionRecorded & {readonly values:string[]}}){return value;}
export function optionalReadonlyUnionAttachment(value:{readonly message?:UnionRecorded & {readonly tag:string}}){return value;}
type UnionCopy=UnionRecorded;
export function copiedUnion(value:{readonly message?:UnionCopy}){return value;}
type MutableUnionCopy=UnionRecorded & {readonly payload:string[]};
export function mutableUnionCopy(value:{readonly message?:MutableUnionCopy}){return value;}
`,
    );
    const rule = "typescript/prefer-readonly-parameter-types";
    const findings = (path, names = ["RecordedToolResult", "UnionRecorded"]) =>
      lint(dir, [rule], ["main.ts"], {
        overrides: [],
        rules: {
          [rule]: [
            "error",
            {
              ...config.rules[rule][1],
              allow: [{ from: "file", path, name: names }],
            },
          ],
        },
      });
    const expected = (lines) => lines.map((line) => ({ rule, file: "main.ts", line }));
    assert.deepEqual(
      findings("./owned/history-display.ts"),
      expected([11, 12, 13, 14, 15, 17, 19, 23, 25, 29, 31, 35, 36, 37, 38, 39, 40, 45]),
    );
    assert.deepEqual(
      findings("./foreign/history-display.ts"),
      expected([
        7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34,
        35, 36, 37, 39, 40, 41, 43, 45,
      ]),
    );
    assert.deepEqual(
      findings("./owned/history-display.ts", ["UnionRecorded"]).filter((entry) => entry.line >= 32),
      expected([35, 36, 37, 38, 39, 40, 45]),
    );
    assert.deepEqual(
      findings("./foreign/history-display.ts", ["UnionRecorded"]).filter(
        (entry) => entry.line >= 32,
      ),
      expected([32, 33, 34, 35, 36, 37, 39, 40, 41, 43, 45]),
    );
    const compiled = compiler(dir);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  } finally {
    remove(dir);
  }
});
