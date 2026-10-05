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
- Local correction: `patches/tsgolint-safe-call.patch`
- Dependencies: upstream `go.mod`, `go.sum`, `go.work`, and `go.work.sum`; build uses
  `-mod=readonly`, `-trimpath`, `-buildvcs=false`, and `CGO_ENABLED=0`

The cache manifest records source/submodule revisions, the local patch SHA-256,
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
