# Quality exceptions

These decisions follow Section 2 of the [v5.2 standard](strict-oxlint-oxfmt-standard.md).
They preserve supported contracts rather than tolerate existing findings.
All use Oxlint 1.91.0 and oxlint-tsgolint 7.0.2006.
`quality/directives.ts` binds each site to its file, rule, enclosing owner, and
operation. Its inventory is not a finding-count budget.

The audit at base `7f449e2` found 353 real lint directive comments in 61 files:
318 next-line directives and 35 range/file/enable directives. The current code
has 23 next-line directives in 11 files and no range or file disables.
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
| `src/agent/host.ts:111`                      | SDK from the caller-selected package root.                 |
| `src/agent/observe-layout.ts:18`             | Selected host's TUI root.                                  |
| `src/agent/observe-layout.ts:20`             | That TUI's layout module.                                  |
| `src/agent/observe-layout.ts:22`             | That TUI's dispatch module.                                |
| `src/agent/typebox.ts:11`                    | Detached child's selected TypeBox instance.                |
| `src/agent/typebox.ts:16`                    | The same graph's TypeBox value operations.                 |
| `.github/scripts/ci-host.mjs:31`             | `common.mjs` from the workflow-pinned automation checkout. |
| `.github/scripts/ci-host.mjs:36`             | `hosts.mjs` from that same automation checkout.            |
| `scripts/package-smoke.mjs:157`              | Installed package's emitted host loader, not source.       |
| `scripts/package-smoke.mjs:187`              | Installed package's emitted broker launcher.               |
| `test/support/native-host.ts:13`             | Pi AI companion resolved from the caller-selected SDK.     |
| `test/fixtures/single-agent-shutdown.mjs:36` | Supplied repository's compiled agent entry.                |
| `test/fixtures/single-agent-parent.mjs:96`   | Supplied repository's compiled agent entry.                |
| `test/fixtures/single-agent-parent.mjs:101`  | Its already-loaded process owner.                          |
| `test/fixtures/single-agent-parent.mjs:106`  | Its already-loaded session-target owner.                   |
| `test/fixtures/single-agent-parent.mjs:111`  | Its already-loaded storage owner.                          |
| `test/fixtures/single-agent-parent.mjs:116`  | Its compiled intercom extension when that phase needs it.  |
| `test/fixtures/single-agent-parent.mjs:516`  | Its compiled broker client constructor.                    |

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
compare exact SDK/TypeBox identities and exercise actual emitted consumers.
The CI automation interfaces match the workflow's immutable automation revision
`c832dd07c016914db40bb98e5bdbb9c623cd6303`; its actual host qualification exercises
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
