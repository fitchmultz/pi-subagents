# Quality exceptions

These decisions follow Section 2 of the [v5.2 standard](strict-oxlint-oxfmt-standard.md).
They preserve supported contracts rather than tolerate existing findings.
All use Oxlint 1.94.0 with `tsrs` 7.1.0-beta.tsrs2 (see `QX-008`).
`quality/directives.ts` binds each site to its file, rule, enclosing owner, and
operation. Its inventory is not a finding-count budget.

The audit at base `7f449e2` found 353 real lint directive comments in 61 files:
318 next-line directives and 35 range/file/enable directives. The current code
has 21 next-line directives in 10 files and no range or file disables.
Literal examples in tests and documentation are not directives.

Removed protections are not silently waived: JSON enters as `unknown` and is
validated, native filesystem signatures retain their overloads, genuine shared
host resolution is reused, and promise cleanup uses owned `try/finally`.
The old per-rule suppression-count test is removed. QX-002's five-parameter
exception is also removed: `execute(...[, params, signal, , ctx])` preserves the
SDK's contextually typed positional contract without changing its callers.

Line numbers below identify directive comments. The following line is the
authorized operation. The checker uses operation identity, not these line numbers.

## QX-001 Node test registrations

Rule: `typescript/no-floating-promises`, test-profile
`allowForKnownSafeCalls` at `.oxlintrc.json:364`.
The installed `@types/node` version is 24.19.2. Only actual `node:test`
declarations imported as `nodeTest`, `nodeIt`, or `nodeDescribe` qualify.

Node owns top-level and suite-body registration promises. Awaiting each
registration changes module/hook timing; collecting them changes registration
ownership. Prefixing calls with `void` is not a compliant alternative because
`ignoreVoid:false` remains required. The chosen native origin allowance avoids
those scheduling changes without disabling floating-promise checks in tests or
production.

`lint-node-test-allowance.test.ts` retains all six native controls: each used
registration form passes at top level and inside a suite; context subtests,
same-named locals, same-named imports from other modules, floating work inside
tests, and unrelated promise calls fail at their exact locations.

Lost detection: declaration matching cannot infer calling context. An imported
registration called inside a running test could create an unawaited subtest.
Use awaited/returned context methods inside running tests. Review and rerun the
six controls when Node declarations, import forms, or native matching change.

## QX-003 Shared native event mutation

Rule: `no-param-reassign` with `props:true` and empty ignore lists.

| Directive location                               | Authorized operation                                  | Why a copy is wrong                                            |
| ------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------- |
| `test/fixtures/native-execution-cwd-owner.ts:59` | `before_agent_start`: `event.systemPromptOptions.cwd` | Pi reads the same structured prompt draft after the handler.   |
| `test/fixtures/native-execution-cwd-owner.ts:65` | `tool_call`: `event.input.path`                       | Pi executes the same mutable input after directory resolution. |
| `test/fixtures/native-execution-cwd-owner.ts:78` | execution-cwd bus request: `request.result`           | The bus caller reads the response on the request it sent.      |

The actual compliant copy alternative, `const updated = { ...event.input,
path: resolve(cwd, event.input.path) }`, does not update the object Pi executes.
Returning that copy is not this callback's protocol. An alias would merely hide
the same mutation. These are supported-contract exceptions, not exceptions for
all parameters named `event` or `request`.

Native execution-cwd integration tests exercise the shared objects against the
real host. The native directive qualification removes the directive and requires
`no-param-reassign`; the policy keeper rejects copied/wrong operations and
multiple assignments on one directive line. All other mutations remain checked.
Revisit when the SDK or directory-owner protocol offers a returned-value API.

## QX-004 Selected-runtime and built-artifact imports

Rule: `typescript/no-unsafe-assignment`. Computed `import(url)` has type `any`.
The receiving declaration uses the authoritative SDK or source module type,
rather than allowing `any` to propagate.

| Directive location                           | Runtime artifact and required identity                     |
| -------------------------------------------- | ---------------------------------------------------------- |
| `src/agent/host.ts:135`                      | SDK from the caller-selected package root.                 |
| `src/agent/observe-layout.ts:18`             | Selected host's TUI root.                                  |
| `src/agent/observe-layout.ts:20`             | That TUI's layout module.                                  |
| `src/agent/observe-layout.ts:22`             | That TUI's dispatch module.                                |
| `.github/scripts/ci-host.mjs:31`             | `common.mjs` from the workflow-pinned automation checkout. |
| `.github/scripts/ci-host.mjs:36`             | `hosts.mjs` from that same automation checkout.            |
| `scripts/package-smoke.mjs:178`              | Installed package's emitted host loader, not source.       |
| `scripts/package-smoke.mjs:192`              | Installed package's emitted broker launcher.               |
| `test/support/native-host.ts:13`             | Pi AI companion resolved from the caller-selected SDK.     |
| `test/fixtures/single-agent-shutdown.mjs:36` | Supplied repository's compiled agent entry.                |
| `test/fixtures/single-agent-parent.mjs:146`  | Supplied repository's compiled agent entry.                |
| `test/fixtures/single-agent-parent.mjs:151`  | Its already-loaded process owner.                          |
| `test/fixtures/single-agent-parent.mjs:156`  | Its already-loaded session-target owner.                   |
| `test/fixtures/single-agent-parent.mjs:161`  | Its already-loaded storage owner.                          |
| `test/fixtures/single-agent-parent.mjs:166`  | Its compiled intercom extension when that phase needs it.  |
| `test/fixtures/single-agent-parent.mjs:601`  | Its compiled broker client constructor.                    |

The simple statically typed alternative is:

```ts
import * as sdk from "@earendil-works/pi-coding-agent";
import agents from "../../src/agent/index.ts";
```

That resolves the fixture's development graph and source, not a caller-selected
SDK or installed artifact. It loses the very behavior these owners and tests
promise. Static imports of private emitted JavaScript also pull stripped output
into checked-JS compilation; a measured alternative produced missing annotations
and incompatible generic storage signatures. Adding permissive declarations
would not prove that arbitrary selected artifacts match them.

Several boundaries do disappear through real reuse: three fixture SDK imports use
the existing `loadSDK`, and four companion lookups share `loadNativeAI`, which
owns SDK-relative resolution. Compatible smoke-script imports use literal package
specifiers after `compat-host.mjs` verifies their graph. The remaining sites cannot
use that narrower assumption without dropping caller-selected roots or testing
source instead of production output.

Safety rests on trusted installed/generated code and matched host qualification,
not a property-presence predicate. Such a predicate cannot verify class private
brands, overloads, generics, or return contracts. `packageRoot` validates SDK
package identity; companion resolution starts at that root. Build/package smokes
compare exact SDK identity, verify detached runtime modules validate on
`@earendil-works/pi-schema` without loading `typebox`, and exercise actual
emitted consumers.
The CI automation interfaces match the workflow's immutable automation revision
`1f78bd6585d8a5570f0226cca0b6877c9f4dd9c2`; its actual host qualification exercises
both imported APIs.

The native qualification requires accepted annotated imports to pass and the
same imports without directives to report `no-unsafe-assignment`.
The policy keeper rejects a directive moved to another computed import even
with the total unchanged. All downstream unsafe-call, member, argument, return,
and assertion rules remain active.

Lost detection: these assignments trust that the selected module implements its
declared ABI. Unsupported or substituted code can violate that assumption.
Official/fork compatibility, artifact provenance, class identity, and real
consumer tests remain required. Revisit on module-path, SDK ABI, build-output,
automation-revision, or native computed-import typing changes.

## QX-005 Isolation before module evaluation

Rule: `import/no-unassigned-import`, test-profile allowance at
`.oxlintrc.json:374`, limited to `../support/isolated-home.ts` and
`./isolated-home.ts`. The parser also resolves the relative request and requires
the actual owner `test/support/isolated-home.ts`, not a same-named file elsewhere.

This module sets private HOME, runtime paths, and child environment before
imported production modules evaluate. Calling an initializer in the test body
runs after static imports and can initialize storage against the real user home.
Importing a token just to appease lint adds a dummy export without changing the
side-effect contract. A dynamic-import rewrite of every consumer would alter
module evaluation solely to avoid an accurately intentional side-effect import.

Other unassigned imports remain errors. Native lint checks the allowed requests;
the policy keeper rejects a wrong-origin same-named bootstrap. The isolated
filesystem/process tests verify runtime behavior. Lost detection is limited to
this owner's intentional initialization. Revisit if isolation moves to a native
runner preloader that also covers direct test execution.

## QX-006 Fork working-session participation

Rule: `typescript/no-unsafe-type-assertion` at
`test/fixtures/single-agent-provider.mjs:165`, only the bound `pi.on` used for
`working_session_save`. This event is implemented by the maintained fork but
absent from official Pi's event overloads.

The fixture derives the event from the selected SDK when declared and otherwise
uses its explicit compatibility shape: signal, boundary, invalidation, and entry
append. The returned value is ignored and typed `void`. The fork's native event
awaits participation; the official host never emits it and keeps actors resident.

Calling `pi.on("working_session_save", handler)` directly cannot compile under
official declarations. Removing the handler drops real save-race/orphan coverage.
Using `pi.events.on` registers on a different bus. A generic `Function` guard or
reflective call would lose the argument/result contract without proving the event.

The native qualification reproduces the exact JSDoc assertion and requires its
unsafe-assertion diagnostic without the directive. Native park-command, orphan,
and saved-generation tests exercise the fork event; official tests exercise the
resident fallback. Lost detection is this one overload bridge, not arbitrary SDK
calls. Revisit when official Pi declares the event or the fork changes its contract.

## QX-007 Native SQLite receiver forwarding

Rule: `typescript/unbound-method` at
`test/fixtures/intercom-wake-window.ts:183`, capturing
`DatabaseSync.prototype.exec` for the publish fixture. Its only call is
`nativeExec.call(this, sql)` inside the replacement native instance method.

The fixture pauses the real exclusive-lock operation after publication. It does
not substitute lock or admission results. Binding the prototype instead is a
real failure:

```ts
const exec = DatabaseSync.prototype.exec.bind(DatabaseSync.prototype);
exec("CREATE TABLE actual(value TEXT)"); // TypeError: Illegal invocation
```

The same operation through `nativeExec.call(db, sql)` creates the real table.
Binding a particular database would require exposing the production owner's
private instance or adding a test-only injection API. A wrapper or reflective
alias would conceal the same capture rather than fix receiver ownership.

The native qualification checks the capture diagnostic. The policy checker also
requires the one real-receiver call and rejects prototype binding, escape, extra
calls, and replacement with an arrow. Native wake-window integration tests own
the actual lock/admission behavior. Lost detection at the capture is replaced by
this bounded receiver check; other unbound methods remain errors.
Revisit if Node's declaration or the fixture's native interception changes.

## QX-008 Rust type-aware lint backend (`tsrs` replacing `oxlint-tsgolint`)

Standard requirement: Section 5.1 ("Published tools and compatibility") specifies
the latest stable published releases of Oxlint, `oxlint-tsgolint`, and Oxfmt.
Installed tool versions: `oxlint@1.94.0`, `tsrs@7.1.0-beta.tsrs2`
(`node_modules/tsrs/package.json` reports `typescriptVersion: "7.1.0-beta"` and
`typescriptCommit: "3e9236361fa97a9e6c685f4833ac457ae2d8c50a"`, invoked through
`node_modules/.bin/tsrs-lint` and `@tsrs/<platform>`), `oxfmt@0.79.0`,
`typescript@7.0.2` (canonical compiler gate retained), `oxc-parser@0.157.0`, and
`@types/node@24.19.2`. Replaced package: `oxlint-tsgolint` (`7.0.2006` baseline;
matched A/B compared against `7.0.2007`).

Scope: all `typeAware: true` lint invocations across the repository's 254
maintained TypeScript and checked JavaScript files (`npm run lint`,
`npm run lint:agent`, `npm run lint:fix`, and `test/support/lint-probes.ts`).
`npm run typecheck`, `npm run typecheck:declarations`, and `npm run build` stay
on `typescript@7.0.2` (`tsc`) with Oxlint `typeCheck: false`. On unsupported
platforms without a published `@tsrs/*` optional binary (Android),
`test/support/lint-probes.ts` skips semantic probes and supported Linux/macOS CI
hosts remain required for full acceptance.

Actual compliant alternative and demonstrated cost: keep `oxlint-tsgolint@7.0.2007`
(optional peer dependency of `oxlint@1.94.0`). On `mitchs-m5-mbp` (Darwin arm64,
Node `v24.22.3`), median of 3 warm runs measured with `/usr/bin/time -l` on
`./node_modules/.bin/oxlint --type-aware --deny-warnings .` using the same
`oxlint@1.94.0` binary:

| Backend (`oxlint@1.94.0`)                           | Wall times (s)   | Median wall (s) | Median CPU (s) | Peak RSS runs (bytes)              |            Median peak RSS |
| --------------------------------------------------- | ---------------- | --------------: | -------------: | ---------------------------------- | -------------------------: |
| `oxlint-tsgolint@7.0.2007` (`OXLINT_TSGOLINT_PATH`) | 1.69, 1.43, 1.82 |            1.69 |           6.56 | 1555054592, 1460912128, 1450246144 | 1393.23 MiB (1460912128 B) |
| `tsrs@7.1.0-beta.tsrs2` (default `tsrs-lint`)       | 0.34, 0.38, 0.37 |            0.37 |           1.86 | 569999360, 570720256, 575586304    |   544.28 MiB (570720256 B) |

Pre-upgrade baseline on `oxlint@1.91.0` + `oxlint-tsgolint@7.0.2006` measured
`1.16s` median wall time (runs `1.16s`, `1.08s`, `1.41s`) and `1404.16 MiB`
(`1,472,364,544` bytes) median peak RSS (runs `1,472,364,544`, `1,341,079,552`,
`1,515,749,376` bytes). In the matched `oxlint@1.94.0` comparison on this
repository, `tsrs` was 4.57x faster in wall time (0.37s vs 1.69s) and 3.53x
faster in CPU time (1.86s vs 6.56s) with 2.56x / 848.95 MiB lower peak RSS
(544.28 MiB vs 1393.23 MiB, a 60.9% reduction).

Eligibility ground: explicit maintainer-directed efficiency migration
substituting `tsrs@7.1.0-beta.tsrs2` for `oxlint-tsgolint` across maintained
`fitchmultz` Pi packages (aligned with `fitchmultz/.github#182` `QX-001` and
`fitchmultz/pi-agent-skills#128`, keeping normative Section 5.1 intact and
preserving `tsc@7.0.2` as the canonical compiler gate). Neither
`docs/strict-oxlint-oxfmt-standard.md` nor `docs/code-quality.md` specifies a
numeric lint time or memory budget; this record does not assert a Section 2.1
ground 1 ceiling violation and rests on explicit repository-owner direction plus
the measured local efficiency gains without weakening any Appendix A rule,
structural limit, policy check, or compiler gate.

Chosen adjustment and scope: replace `oxlint-tsgolint` with `tsrs@7.1.0-beta.tsrs2`
in `package.json` and `package-lock.json`, retain `typescript@7.0.2` (`tsc`),
keep `.oxlintrc.json` unchanged, update `test/support/lint-probes.ts` to probe
`@tsrs/<platform>`, strip all `TSRS_*` and `OXLINT_TSGOLINT_*` overrides
(including `TSRS_BINARY`, `TSRS_LIB_PATH`, `OXLINT_TSGOLINT_PATH`,
`OXLINT_TSGOLINT_TRACE`, `OXLINT_TSGOLINT_CPU`, `OXLINT_TSGOLINT_HEAP`,
`OXLINT_TSGOLINT_ALLOCS`, and
`OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS`) via
`sanitizeLintEnv`, and use Oxlint's default `tsrs-lint` resolution, while
retaining missing/invalid backend and env-stripping tests in
`test/unit/strict-oxlint-qualification.test.ts`.

Retained protection, lost detection, version skew, and assumptions: all Appendix A
rules, categories, `typeAware: true`, `denyWarnings: true`, unused-disable checks,
structural limits, `quality/check.ts` policy/coverage/directive checks, native
probe controls, and `tsc@7.0.2` compiler checks stay active. Two limits remain:

1. **Compiler-version skew:** `tsrs@7.1.0-beta.tsrs2` targets TypeScript
   `7.1.0-beta`, while the canonical compiler gate runs pinned `typescript@7.0.2`.
   Semantic lint type inference follows TS `7.1.0-beta` rather than `7.0.2`;
   `npm run typecheck` (`tsc@7.0.2`) remains required to enforce the pinned
   compiler contract.
2. **Non-continuous `oxlint-tsgolint` cross-checking:** because `oxlint-tsgolint`
   is not installed in `package.json` or `package-lock.json`, CI does not
   continuously cross-check `tsrs` output against `oxlint-tsgolint`. Parity is
   verified manually via `OXLINT_TSGOLINT_PATH` on upgrades or diagnostic
   disputes.

Verification commands, probes, and verified code revision: base `main` revision
`fe5ba3603edf97a8afac7be7bced5b3e6cbb5a32`; verified code/toolchain revision
`962cb87cb71fc3987f674364b7ce6af9abec050a` (re-verified on the final doc head):

- `npm run lint` (`./node_modules/.bin/oxlint --type-aware --deny-warnings .`): exit 0
- `OXLINT_TSGOLINT_PATH=<tmp>/node_modules/@oxlint-tsgolint/darwin-arm64/tsgolint ./node_modules/.bin/oxlint --type-aware --deny-warnings .`: exit 0
- `npm run typecheck` (`tsc 7.0.2`) and `./node_modules/.bin/tsrs --noEmit` (`7.1.0-beta`): both exit 0
- Fail-closed probes (automated in `test/unit/strict-oxlint-qualification.test.ts`
  and verified manually): `OXLINT_TSGOLINT_PATH=/nonexistent/tsrs-lint` exits 1;
  isolated directory without `tsrs` or `oxlint-tsgolint` exits 1 (`Failed to find
  type-aware linter executable`); `tsrs` without `@tsrs/darwin-arm64` exits 1
  (`Cannot find the optional dependency @tsrs/darwin-arm64`)
- `npm run format:check`, `npm run typecheck:declarations`, `npm run check:quality`,
  `npm run build`, and `npm run test:unit` (163 tests: 160 passed, 0 failed, 3
  Linux-procfs skipped on macOS; all 6 native lint qualification and `node:test`
  controls passed): all exit 0

Revisit trigger: revisit when `tsrs` publishes a stable release or matches the
repository's pinned `typescript` version, when `typescript` upgrades to `7.1.x`
or Section 5.1 adopts `tsrs`, when `oxlint` or `tsrs` changes `tsrs-lint`
resolution or semantic rule behavior, or when a diagnostic diverges between
`tsrs`, `tsc`, or an `oxlint-tsgolint` `OXLINT_TSGOLINT_PATH` cross-check.

## Review and verification

The adoption used a separate read-only reviewer. Its accepted findings removed
a proposed async-finally exception, removed redundant value guards, and tightened
compiler coverage and operation attachment. The five-parameter exception was
replaced with the actual typed rest tuple, rather than preserving an unsupported
claim that destructuring was impossible.

The normal acceptance tests retain native allowance/directive controls and policy
mutation controls. The adoption PR records exact-head local and hosted commands,
results, and reviewer disposition. Changes to these decisions require a contract
comparison and relevant native evidence in the same review; adding an identifier
alone does not authorize a new exception.
