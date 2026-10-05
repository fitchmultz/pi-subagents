# Corrected type-aware quality engine

`oxlint-tsgolint` 7.0.2003 accepts file-qualified safe-call allowances by spelling
rather than declaration identity. Its callable-type fallback also exempts
`TestContext.test()` when top-level `node:test` registration is approved.
Both are false negatives, not changes to application Promise ownership.

`patches/tsgolint-safe-call.patch` resolves the actual callee symbol, follows import
and re-export aliases, and checks its original name and declarations with the
existing qualified matcher. Instance methods and property/accessor symbols do not
inherit registration ownership. Callable-type matching is deliberately not a
fallback: unrelated values can have the same function type. Exact file matching
canonicalizes symlinks and uses the host's path case sensitivity. Promise checks
and the safe-Promise matcher are otherwise unchanged.

## Reproduce the build

On macOS or Linux (arm64 or x64), install Git and Go 1.26 or newer, then run:

```sh
npm ci --ignore-scripts
node scripts/setup-quality-engine.mjs
OXLINT_TSGOLINT_PATH="$PWD/node_modules/.cache/pi-quality-engine/tsgolint" \
  node_modules/.bin/oxlint --type-aware .
```

The real CI workflow must explicitly call setup after `npm ci --ignore-scripts`.
Local lint/fix/agent and editor invocations must set `OXLINT_TSGOLINT_PATH` to this
same binary; invoking unconfigured raw Oxlint uses the defective npm backend.
The package remains lockfile-pinned and unmodified. No postinstall or downloaded
replacement executable is required. The first build needs network access to GitHub
and the Go module proxy; a verified cached binary needs neither Go nor network.

Build inputs:

- tsgolint release 7.0.2003: `eb9339115edde6811ca94c3433adf69ea9852880`
- TypeScript Go submodule: `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`
- Upstream TypeScript patches: the ordered `patches/*.patch` at that exact tsgolint
  revision, applied as in its canonical `just init` build
- Local corrections, applied in order: `patches/tsgolint-safe-call.patch`,
  `patches/tsgolint-readonly-collections.patch`, and
  `patches/tsgolint-qualified-readonly.patch`
- Dependencies: upstream `go.mod`, `go.sum`, `go.work`, and `go.work.sum`; build uses
  `-mod=readonly`, `-trimpath`, `-buildvcs=false`, and `CGO_ENABLED=0`

The cache manifest records source/submodule revisions, all three local patch SHA-256 hashes,
host platform/architecture, Go version, and binary SHA-256. Setup rebuilds when
inputs change or the cached executable's digest differs. `--force` rebuilds from
fresh sources; `--help` documents invocation. Cache artifacts live under
`node_modules`, not maintained source or the published extension runtime.

## Qualification and removal

Run the actual native Oxlint CLI allowance-identity matrix after clean installation
and every engine change. It must check approved declarations, wrong existing paths,
local same names and shadows, foreign files and packages, aliases/re-exports,
ordinary async work, and unawaited subtests in the same effective scope. Match
rule IDs and locations, not just exit status.

The examined upstream head `c8f5cbc884b706c42efb8b451fe31d2f1079df10` retains the
same defective code. Replace this patch/build only when a compatible upstream
release passes the complete matrix; version/schema acceptance alone is not proof.

The helper's file-path canonicalization is shared with other qualified rules, but
this does not establish readonly-container behavior or justify readonly relaxations.

## Readonly-container content correction

With `treatMethodsAsReadonly: false`, this unsuppressed input reports:

```ts
export function inspect(value: ReadonlyMap<string, string>) {
  return value;
}
```

That is a method-ownership limitation, not a demonstrated primitive-map checker
defect: TypeScript accepts `value.get = () => undefined`. `ReadonlySet.has` is also
assignable. Upstream describes this as
[working as intended](https://github.com/typescript-eslint/typescript-eslint/issues/8013).
The option remains false; no container allowlist or method-ownership relaxation is added.

Native CLI probes accept `Readonly<ReadonlyMap<string, string>>` and
`Readonly<ReadonlySet<string>>`, whose method properties are actually readonly.
They reject mutable `Map`, mutable `Set`, and `readonly string[][]`, while accepting
`readonly (readonly string[])[]`.

The unpatched rule also accepts `Readonly<Map<string, string>>` despite callable
`set`, and accepts `Readonly<ReadonlyMap<string, { values: string[] }>>` despite
mutable nested values. Independent compiler probes accept both `wrapped.set(...)`
and `nested.get(...)?.values.push(...)`; these are genuine content-checking gaps.

The separate `tsgolint-readonly-collections.patch` closes those negative paths:

- Identify native collection members by actual default-library declarations and
  their owning `Map`, `Set`, `ReadonlyMap`, or `ReadonlySet` interfaces. Local or
  foreign same-named types retain ordinary structural checks.
- Reject native mutation operations even when a mapped facade makes the method
  properties readonly.
- Recursively inspect the instantiated native `forEach` callback's value/key types
  with the existing readonly checker and cycle tracking. This also works through
  outer `Readonly`, `Partial`, `Required`, `Pick`, and repository type aliases.
- Retain ordinary method/property ownership checks: raw native readonly maps/sets
  still report under `treatMethodsAsReadonly: false`. No patch adds a blanket
  container allowance or changes general callback-result/purity semantics.

The native regression matrix accepts primitive/deeply readonly wrapped containers,
including nested arrays, objects, maps, sets and recursive types, while rejecting
mutable containers, keys, values, nested arrays and mutable attached callback state.
This is an input-contract check, not proof of callback purity or runtime freezing.

## Qualified readonly alias and intersection integrity

`tsgolint-qualified-readonly.patch` fixes two additional origin/scope defects:

- The matcher selected an alias's name but its underlying generic interface's
  source file. It now uses the alias symbol's declarations when the alias supplied
  the matched name, so an exact file-qualified, non-generic native wrapper can
  pass without granting permission to every instantiation of the SDK generic.
- Native approval previously short-circuited an entire intersection when any part
  was approved. The readonly rule now accepts an exact whole-type declaration
  match, including approved SDK intersection aliases, but otherwise checks every
  intersection constituent independently. `Theme & { state: string[] }` therefore
  reports while `Theme & { readonly labels: readonly string[] }` retains native
  permission. The existing any-member matcher remains unchanged for other rules.

For a fixed alias such as `SubagentExecutionResult = AgentToolResult<ReadonlyDetails>`,
qualify its actual declaration file, not the `AgentToolResult` SDK generic. Probe
import/re-export aliases, local shadows, foreign declarations with the same filename
or name, wrong existing paths, direct mutable generic payloads, and mutable versus
readonly intersection attachments. A broad native generic allowance still accepts
all its instantiations; it must not be used to bypass owned payload contracts.
Neither this correction nor the configuration adds generic SDK-argument permission
or changes general callback-result checks.
