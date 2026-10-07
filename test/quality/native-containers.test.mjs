import assert from "node:assert/strict";
import { test } from "node:test";
import { config, fixture, lint, put, remove, compiler } from "./probe-support.mjs";

await test("native collection projections retain stored-data and mutation contracts", () => {
  const dir = fixture();
  const cases = [
    ["ReadonlyMap<string,string>", false],
    ["ReadonlySet<string>", false],
    ["Readonly<ReadonlyMap<string,string>>", true],
    ["Readonly<ReadonlySet<string>>", true],
    ["Readonly<ReadonlyMap<string,{values:string[]}>>", false],
    ["Readonly<ReadonlySet<{values:string[]}>>", false],
    ["Map<string,string>", false],
    ["Set<string>", false],
    ["Readonly<Map<string,string>>", false],
    ["Readonly<Set<string>>", false],
    ["readonly string[]", true],
    ["readonly (readonly string[])[]", true],
    ["readonly string[][]", false],
    ["Readonly<ReadonlyMap<string,readonly string[]>>", true],
    ["Readonly<ReadonlyMap<string,string[]>>", false],
    ["Readonly<ReadonlyMap<string,ReadonlyMap<string,string>>>", false],
    ["Readonly<ReadonlyMap<string,Readonly<ReadonlyMap<string,string>>>>", true],
    ["Readonly<ReadonlySet<Readonly<ReadonlyMap<string,string>>>>", true],
    ["Readonly<ReadonlyMap<Readonly<{values:string[]}>,string>>", false],
    [
      "Readonly<ReadonlyMap<Readonly<{values:readonly string[]}>,Readonly<{values:readonly string[]}>>>",
      true,
    ],
    [
      "Readonly<ReadonlyMap<string,Readonly<ReadonlySet<Readonly<{values:readonly string[]}>>>>>",
      true,
    ],
    ["Readonly<ReadonlyMap<string,Readonly<ReadonlySet<Readonly<{values:string[]}>>>>>", false],
    ["Readonly<ReadonlyMap<string,Readonly<Map<string,string>>>>", false],
    ["ImmutableMap", true],
    ["MutableContents", false],
    ["Recursive", true],
    ["MutableRecursive", false],
    ["fake.ReadonlyMap<string,string[]>", false],
    ["fake.ReadonlyMap<string,readonly string[]>", true],
    ["fake.Map<string,string>", true],
    ["()=>Map<string,string>", true],
    ["()=>T", true],
    ["ForeignReadonlyMap<string,string[]>", false],
    ["ForeignReadonlyMap<string,readonly string[]>", true],
    ["Readonly<Partial<ReadonlyMap<string,string[]>>>", false],
    ["Readonly<Partial<ReadonlyMap<string,readonly string[]>>>", true],
    ["Readonly<Required<ReadonlyMap<string,string[]>>>", false],
    ["Readonly<Pick<ReadonlyMap<string,string[]>,keyof ReadonlyMap<string,string[]>>>", false],
    ["(()=>T)&{values:string[]}", false],
    ['Readonly<Omit<Map<string,string>,"forEach">>', false, 'value.set("x","new"); return value;'],
    ['Readonly<Omit<Set<string>,"forEach">>', false, 'value.add("new"); return value;'],
    ['Readonly<Pick<Map<string,string>,"set">>', false, 'value.set("x","new"); return value;'],
    ['Readonly<Pick<Set<string>,"add">>', false, 'value.add("new"); return value;'],
    [
      'Readonly<Pick<ReadonlyMap<string,{values:string[]}>,"get">>',
      false,
      'value.get("x")?.values.push("new"); return value;',
    ],
    ['Readonly<Pick<ReadonlyMap<string,readonly string[]>,"get">>', true],
    [
      'Readonly<Omit<ReadonlySet<{values:string[]}>,"forEach">>',
      false,
      'for(const item of value.values()){item.values.push("new");} return value;',
    ],
    ['Readonly<Omit<ReadonlySet<readonly string[]>,"forEach">>', true],
    ['Readonly<Pick<ReadonlyMap<string,string[]>,"values">>', false],
    ['Readonly<Pick<ReadonlyMap<string,readonly string[]>,"values">>', true],
    ['Readonly<Pick<ReadonlyMap<{values:string[]},string>,"keys">>', false],
    ['Readonly<Pick<ReadonlyMap<{readonly values:readonly string[]},string>,"keys">>', true],
    ['Readonly<Pick<ReadonlyMap<string,string[]>,"entries">>', false],
    ['Readonly<Pick<ReadonlyMap<string,readonly string[]>,"entries">>', true],
    ['Readonly<Pick<ReadonlySet<string[]>,"entries">>', false],
    ['Readonly<Pick<ReadonlySet<readonly string[]>,"entries">>', true],
    ["Readonly<Pick<ReadonlyMap<string,string[]>,typeof Symbol.iterator>>", false],
    ["Readonly<Pick<ReadonlyMap<string,readonly string[]>,typeof Symbol.iterator>>", true],
    ["Readonly<Pick<ReadonlySet<string[]>,typeof Symbol.iterator>>", false],
    ["Readonly<Pick<ReadonlySet<readonly string[]>,typeof Symbol.iterator>>", true],
    ['Readonly<Partial<Pick<ReadonlyMap<string,string[]>,"get">>>', false],
    ['Readonly<Partial<Pick<ReadonlyMap<string,readonly string[]>,"get">>>', true],
    [
      "Readonly<{get:()=>string[]; values:()=>IterableIterator<string[]>; entries:()=>IterableIterator<[string,string[]]>; set:()=>void}>",
      true,
    ],
    ["Readonly<Pick<ReadonlySet<[string,string]>,typeof Symbol.iterator>>", false],
    ["Readonly<Pick<ReadonlySet<readonly [string,string]>,typeof Symbol.iterator>>", true],
    ["ProjectedRecursive", true],
    ["Branch", true],
    ["MutableBefore", false],
    ["MutableAfter", false],
  ];
  const prefix = `import type {ReadonlyMap as ForeignReadonlyMap} from "quality-foreign-collection";
type ImmutableMap=Readonly<ReadonlyMap<string,string>>;
type MutableContents=Readonly<ReadonlyMap<string,string[]>>;
type Recursive=Readonly<{children:Readonly<ReadonlyMap<string,Recursive>>}>;
type MutableRecursive=Readonly<{children:Readonly<ReadonlyMap<string,{values:string[]}>>}>;
type ProjectedRecursive=Readonly<{children:Readonly<Pick<ReadonlyMap<string,ProjectedRecursive>,"get">>}>;
interface Branch { readonly children?: readonly Branch[]; }
interface MutableBefore { readonly values: string[]; readonly children?: readonly MutableBefore[]; }
interface MutableAfter { readonly children?: readonly MutableAfter[]; readonly values: string[]; }
declare namespace fake {interface ReadonlyMap<K,V> {readonly keys:K;readonly values:V;readonly forEach:(callback:(value:V,key:K)=>void)=>void;} interface Map<K,V> {readonly keys:K; readonly values:V;readonly forEach:(callback:(value:V,key:K)=>void)=>void;readonly set:()=>void;}}
`;
  try {
    put(
      dir,
      "node_modules/quality-foreign-collection/package.json",
      '{"name":"quality-foreign-collection","types":"index.d.ts"}',
    );
    put(
      dir,
      "node_modules/quality-foreign-collection/index.d.ts",
      "export interface ReadonlyMap<K,V>{readonly keys:K;readonly values:V;readonly forEach:(callback:(value:V,key:K)=>void)=>void;}",
    );
    put(
      dir,
      "main.ts",
      prefix +
        cases
          .map(
            ([type, , operation], index) =>
              `export function case${index}<T>(value:${type}) {${operation ?? "return value;"}}`,
          )
          .join("\n"),
    );
    const rule = "typescript/prefer-readonly-parameter-types";
    const findings = lint(dir, [rule], ["main.ts"], {
      overrides: [],
      rules: { [rule]: ["error", { ...config.rules[rule][1], allow: [] }] },
    });
    const first = prefix.split("\n").length;
    assert.deepEqual(
      findings,
      cases.flatMap(([, pass], index) =>
        pass ? [] : [{ rule, file: "main.ts", line: first + index }],
      ),
    );
    const compiled = compiler(dir);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  } finally {
    remove(dir);
  }
});
