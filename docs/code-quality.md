# Code quality

Correctness, maintainability and trustworthy enforcement are independent requirements. Oxlint owns
quality; Oxfmt owns formatting. TypeScript, builds, native tests and code review remain separate gates.

## Commands

Use Node 24.21+ and the committed npm lockfile. A clean install deliberately does not depend on npm
lifecycle hooks:

```sh
npm ci --ignore-scripts
npm run quality:setup
npm run quality:scope -- --write # after adding/removing code or changing checkJs; review and commit
npm run lint
npm run lint:agent
npm run lint:fix                # safe fixes only; inspect behavior changes
npm run format
npm run ci
npm run quality:sabotage        # clean integrated revision; full baseline CI then five negative controls
```

Each quality executable supports `-h`/`--help`. Unknown arguments and child failures are errors.
`quality` composes engine setup, generated-schema freshness, scope/configuration/suppression policy,
lint, formatting, root TypeScript 7 checking, effective leaf-project checking, installed-CLI probes and
the auxiliary protected-Mac controller's Go checks. Static gates run before expensive native probes so
invalid inputs fail promptly; passing acceptance still requires every probe. `ci` adds the build, package/install smokes and complete test suites.
CI qualifies actual official Pi and fork installations separately; equal version strings are not runtime
proof.

### Acceptance budgets and process ownership

The full acceptance stages are sequential: cold quality (15 minutes), build and install/package
smokes (5), unit tests (5), integration tests (15), then owner settlement (1). The outer CI command
therefore has a 41-minute budget. Compatibility qualification adds editor cloning (5), installation
(5), metadata checks (1), native smoke (5) and settlement (1), for 58 minutes. The host job reserves
120 minutes for that qualification, host/development preparation, production installs and fork/tooling
work. Unit (300000 ms), integration (900000 ms), individual-test and process-cleanup (10 seconds)
limits remain independent; an ancestor timeout must not cut off a permitted child stage.

`scripts/compat-process.mjs` owns commands and private receipt lifetimes. A genuine fork/IPC session
guardian acknowledges cancellation before observation, reserves the command's SID during cleanup and
publishes settlement only after WORK quiesces. Linux uses procfs identities and exact environment
receipts; macOS uses bounded Koffi public-SDK queries for native birth/UID/SID and environment bytes.
Each native query runs in one preemptible same-session child and is reaped on timeout. Streaming output
is decoded across pipe chunks without changing forwarded bytes or caller descriptors.

PID, native birth and UID are revalidated before signalling. Arguments, executable names, role-shaped
metadata and filesystem receipts alone never authorize a signal. Root deletion waits for actual
quiescence and settled guardian lifetimes; observation uncertainty or lost settlement retains the
private roots and propagates `cleanupFailed`, rather than concealing the original command failure.
Nested cleanup defers only current authenticated enclosures whose guardian published its rescue phase
before launching cleanup queries. Connected nested WORK remains signalable, and its original command
owner performs normal cleanup/release. The phase is not quiescence proof: pending lifetimes still need
settlement and actual exit. Even NO-WORK disconnects authenticate the actual native incarnation and
immutable fork metadata before settlement; existing receipts enter rescue phase before that query.
Mismatched metadata retains the live reservation and private roots. Ordinary WORK cannot exempt itself
by copying the guardian directory or baseline hash.

On Linux and macOS, the original pre-WORK native cut is digest-bound to the live guardian. Linux
uses the kernel's actual effective UID, not proc-directory ownership (which can change for non-dumpable
processes). Stable same-UID denied environments are opaque, not signal authority; other native errors
and unstable incarnations remain uncertainties. Unknown opaque work
with neither an exact pre-WORK birth nor a still-reserved foreign SID vetoes success without being
signalled. Exact OWNER entries outside a trustworthy environment boundary also veto success; they are
not argv-based ownership. This is not an adversarial sandbox. An intentional new session with erased
OWNER, a changed UID or an established foreign service boundary requires stronger OS containment.
The keeper isolates its destructive fixtures from inherited receipt placement while retaining enclosing
OWNER tokens, and verifies both ordinary and genuinely nested execution.

Keeper publication registers WORK and nested guardians before assertions. An early fixture failure
still completes the healthy owner's actual stop/release after gates open and command return; a lost
guardian is not settlement, so uncertain receipt roots remain diagnostic evidence. Teardown attempts
all registered fixture reaping, collects failures and reports them once without replacing the original
error; without an unconsumed original failure, cleanup errors fail the row. Darwin fallback observes
the stopped guardian before discovering live authenticated query consumers; protected WORK and exited
children do not grant query signal authority. Receipt-root removal assertions first prove the actual
nonempty root exists, and nested return witnesses bind to that same root. Native query children are
birth/UID-bound and reaped before any manual removal of a proven settled root.

Darwin protected-environment omission depends on the actual host and observer privileges, not an
Apple binary pathname. Local keeper passes do not qualify a remote runner's omission behavior.
Qualification must preserve the protected argv-alignment/empty-argv expectations and independently
establish native OWNER omission; a host exposing that environment requires provisioning, not weaker
expectations, erased OWNER, synthetic bytes or changed cleanup deadlines.

### Protected macOS CI

The Mac fork leg requires `[self-hosted, macOS, ARM64, protected-macos-arm64]`. The label
means a **measured guest boundary**, not a signing label or GitHub image guarantee. Linux legs,
selected hosts, editor/fork/automation pins, assertions and deadlines remain unchanged.

The [SDK controller](../scripts/protected-macos-controller/README.md) owns unattended demand,
repository-scoped official JIT registration and authenticated GitHub run/job/source association.
The native adapter owns one clean Tart clone, pinned SSH, the guest guard and native disposal.
Capacity one includes preparation, assignment, settlement and retained uncertainty: an error does
not free the slot. PR, main, reusable `npm-release.yml` and scheduled genuine releases use the same
owner. A release-enabled main push can require **two serial Mac jobs**. A manual one-job command or
an offline label is not a replacement for this unattended path.

**Qualification status:** the protected guest, native omission, actual keeper workload and
conditional Worker FD/diagnostics/tamper controls have been measured. Real GitHub routing, two-job
replenishment, source capture/ACK, cold SDK session recovery and activation remain separate required
acceptance. Prospective first-hook/consumer binding has source preparation only; do not describe
source trust or unattended deployment as qualified from conditional native controls or local fixtures.

#### Credential-free baseline

Use one Apple Silicon Mac with adequate capacity and one active guest. The measured candidate used
Tart **2.40.1**, official archive SHA256
`363e2701154a8155cbc1bb6d845430c9b42697d2a186bc49574471ca2877db46`, and
`ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640`:
Tahoe 26.6.2/25G83, 6 CPUs, 16 GB RAM and an 80 GB disk. Reject the SIP-disabled **base** image;
a different image needs fresh native qualification. Tart 2.40.1 is FSL-1.1-ALv2, permitting this
internal use; follow Apple's applicable virtualization license.

Keep the operator root persistent, owned and private (0700), with files/keys/password state 0600.
Use separate `TART_HOME`, `TART_NO_AUTO_PRUNE=1`, unique owned names and no prune/overwrite options.
Run Tart with `--no-graphics --no-audio --no-clipboard --no-usb-accessories`; no directories, extra
disks, host environment/agent, Apple ID or guest bridges. Use standard Apple NAT, never bridging or
Softnet (which changes host InternetSharing settings). No host SIP/CSR or privileged settings change
is part of this setup.

Trusted initial setup is guest-local, before any runner registration:

1. Pin the owned guest's initial SSH key. Treat public `admin/admin`, passwordless sudo, cached GUI
   login and shared SSH host keys as bootstrap inputs, not CI credentials.
2. Generate the actual host destination inventory without probing LAN services:
   ```sh
   node scripts/protected-macos-ci.mjs inventory > "$OPERATOR_ROOT/blocked.txt"
   ```
   This normalizes BSD abbreviated networks, host/default/scoped routes and point-to-point peers;
   unresolved relevant entries fail closed. It includes LAN/VPN/CGNAT/public-hairpin IPv4 and reserved
   ranges. Guest loopback remains available; all other IPv6 is denied.
3. Upload `blocked.txt`, the operator **public** key and `protected-macos-guest.sh` to the guest admin
   account. In that guest, invoke the nonexecutable template through `/bin/bash` as root:
   ```sh
   sudo /bin/bash ./protected-macos-guest.sh blocked.txt operator.pub ACTUAL_NAT_GATEWAY
   ```
   Supply two new random passwords (admin, then CI) through authenticated SSH stdin, never argv/logs.
   The template rotates admin credentials and SSH host keys, removes NOPASSWD/autologin, ends the
   admin GUI, disables unnecessary sharing/SSH environment overrides and creates standard UID502 CI.
   Pin the newly returned public SSH key before reconnecting. Close bootstrap channels, then through
   a fresh trusted guest-admin channel activate the root-only PF service:
   ```sh
   sudo /bin/launchctl bootstrap system /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist
   ```
   Its root-owned loader validates/loads the rules, clears states and enables PF. CI must not run
   before enforcement. Root services never execute CI-owned tools or workspace code.
4. Install Apple's CLT in the guest. Install Node `>=24.21.0 <25`, Go 1.27.1, user-owned Homebrew,
   fd/ripgrep and the independently frozen source in `/Users/ci/source`; install its lockfile-resolved
   dependencies. Copy `protected-macos-guest-probe.mjs` to `/Users/ci`. CI owns job tooling, not CLT,
   compiler/SDK parents, PF or the immutable hook/launcher paths.
5. Install official `actions/runner` **2.338.0 ARM64** in `/Users/ci/runner`, verifying archive SHA256
   `df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2`. Do not register/configure a
   service or put credentials in the baseline. Keep `.env`, `.path`, `~/.ssh/environment` and SSH rc
   overrides absent. `qualify` uploads the exact legitimately signed observer input and installs
   immutable hooks after CLT exists; only the other read-only native tools are compiled in the guest.
   It uses no CI compiler, library, PATH or workspace as root. See the source/access requirements below.
6. Create private `state.json` with the schema below and a private qualification seed containing only
   the independently frozen `source: {commit, tree}`. This seed is **not a passing receipt**. Generate
   real evidence and seal it:
   ```sh
   node scripts/protected-macos-ci.mjs qualify --state "$OPERATOR_ROOT/state.json"
   node scripts/protected-macos-ci.mjs seal --state "$OPERATOR_ROOT/state.json"
   ```

The state schema is `version: 1`, `owner: "protected-<eight-hex-id>"`, absolute `root`, `tart`,
`tartHome`, `key`, `knownHosts`, `private` and `qualification` paths inside that root,
`bootstrap: "<owner>-bootstrap"`, `baseline: "<owner>-qualified"`, actual IPv4 `gateway` and
`active: null`. `knownHosts` pins the rotated guest key under the owner alias; `private` names a
0600 JSON file containing `adminPassword`, never a host PAT. `qualification` initially names the
source seed; successful `qualify` replaces that pointer with its generated evidence file.
Observer installation additionally requires `observer: {binary, manifest, sha256}`: private,
nonsymlinked files inside the operator root, an exact signed binary SHA256 and the build's input
manifest. Missing input retains the operation, rather than compiling a substitute.

`qualify` establishes the root-owned, boot-bound **pre-qualification cut before the workload**.
It proves actual CI privilege/PF denial, public HTTPS and denial to both the real gateway and an
independently published own host dummy endpoint on permitted port 443, including owner positive
controls. Ordinary Node proves actual CSR/DTRACE denial and successful restricted argv with inherited
OWNER omitted—not a read error, erased environment, signing-label inference or synthetic bytes.
The genuine official Worker controls prove enabled diagnostics' Unix listener, disabled diagnostics'
zero listeners, actual same-UID task/ptrace denial, and controlled TCP/Unix socket detection. They do
not send a job or certify server-enabled DAP behavior.

The full native keeper runs standalone and genuinely enclosed at exact source blob bytes/modes,
with independent saved-incarnation absence checks and real settlement CI logins. Quiescence renews
two complete native enumerations; vanished/reused/changed entries are uncertainty, not account absence.
No command name exempts work. `seal` checks the **original** qualification cut and credential absence;
it never snapshots survivors into a new exemption. It stops the bootstrap and hashes a new pristine
qualified clone without overwriting earlier baselines. A published surviving fixture vetoed actual
seal and left its bootstrap running in the measured controls.

#### Attached native lifecycle and recovery

The SDK owner invokes one attached adapter through bounded private NDJSON:

```sh
node scripts/protected-macos-ci.mjs controller --state "$OPERATOR_ROOT/state.json"
# run and settle are aliases of this same protocol, not standalone JIT/force-retire commands.
```

The native kernel flock is acquired before journal reload and held through actual listener return,
including EOF, failed readiness and interrupted operators. The never-unlinked guard prevents two
stale settlers from replacing a live lock. Tart is detached from operator terminal signals. One
fsynced native journal owns both foreground state and asynchronous transport-return publication.

`prepare` proves a clean clone before SDK JIT. `launch` records the SDK-returned runner ID before
later assertions and JIT-sent intent before private stdin delivery. The immutable launcher runs
**as CI**, under `env -i` with system PATH first, the exact required hook and
`DOTNET_EnableDiagnostics=0`; it execs official Listener directly, leaving no long-lived parent
holding JIT environment. No host credential or JIT appears in argv, the baseline or public output.

Before ACK the root-native guard checks the original consumer→Worker→Listener ancestry, PID/birth/UID/SID,
executable/argv, all 266 reviewed apphost/managed/runtime/config inputs, and coherent native FD/socket
observations. Missing/unstable/denied observation retains uncertainty. The hook has its own 60-second
native wait; ACK and authenticated completion close capture. Immutable file creation alone never
authenticates its creator or establishes that no public code ran previously.

#### Prospective source and legitimate observer input

Build source without creating an ES client or signing/granting access:

```sh
node scripts/protected-macos-observer-build.mjs "$OPERATOR_ROOT/observer-build"
```

This compile/link recipe produces **unsigned, noninstallable** `observer-unsigned` and
`observer-inputs.json`, binding native modules, reviewed runner manifest, immutable scripts and the
recipe's exact bytes/modes. A trusted build/signing owner must retain that manifest, use Apple's
legitimately approved restricted `com.apple.developer.endpoint-security.client` entitlement and
approved signing/provisioning, then supply the signed binary's actual hash in `state.observer`.
Building requires an installed macOS SDK 27+ containing `es_new_descendants_client`; an older SDK
is unsupported, not a reason to declare the API manually or build a global-client fallback.
The observer requires runtime hardening, force-hard/force-kill, restricted loading and library
validation, without get-task-allow or code-loading bypass entitlements; dynamic validation rejects
debugged code. Source preparation does not sign or manufacture these permissions.
Do not create a fabricated entitlement, ad-hoc-sign an input or treat a signing label as an Apple
grant. Installation checks exact source inputs, binary hash, strict signature and entitlement.
The SDK 27 descendants client requires the restricted entitlement but explicitly **does not require
root or TCC/FDA approval**. Root remains the existing publication/native-cut authority, not an API
privilege workaround. Actual successful client creation and subscription in the installed context
are still required; neither a signing label nor compilation establishes readiness. There is presently
no approved signing/profile/access receipt; a timed-out access question was not consent.

The same trusted observer remains attached to one Listener transport. It creates Apple's direct
`es_new_descendants_client`, unmutes paths for its NOTIFY-only subscriptions, and successfully
subscribes to EXEC/FORK/EXIT
**before forking the launcher or delivering JIT**. Root does not execute workspace/CI tools:
the fresh child drops supplementary groups, GID and UID before executing the fixed, immutable
launcher under the same clean environment. Subscription errors retain/veto; there is no
eslogger/auditpipe/global-client/late-PID fallback or installed service. The documented subtree
includes the calling root, existing descendants and every future fork/exec descendant recursively:
it covers the exact root→launcher→Listener→Worker→first-hook/consumer owner chain while unrelated
processes are invisible. The separate whole-CI-UID native cut/libproc guards remain unchanged.

The implementation requires macOS **27+** for ESClient.h's documented synchronous syscall enqueue
contract. The historically measured 26.6 guest is therefore unavailable for this source path, not
automatically upgraded or requalified. SDK compilation is not runtime compatibility or authorization.
Callbacks are serial in delivery order, not an invented atomic filesystem/liveness barrier. Message
version 4+ is required for global sequence numbers and parent audit tokens; version 3 supplies fork
birth. The exact owned-root→fresh-child FORK is the required prefix anchor. A launcher before/missing
that anchor is rejected; arbitrary first counters, assumed 0/1 and a first matching process are not
loss-free prefix proof. Each following exec links the old audit execution to its target, including
the controlled root→CI credential drop, and each Worker/hook child requires the preceding exact fork.
Global/per-type gaps, reversed event time, another earlier child, re-exec or contradictory parent
identity permanently veto the one-shot gate. No raw environment, JIT, arbitrary arguments or
unrelated global activity is retained; callback state is bounded. The serial callback performs no
filesystem I/O: four fixed in-process publication slots feed one joined writer. Overflow or a write
failure revokes root-owned, read-only shared readiness before an admission can be used; durable
original/sequence records must be durably published before capture/ACK. Readable bytes or a
single-link file are not proof that the writer's final directory fsync completed. Root-only positive
completion words are released only after the hook/original record's complete publication succeeds;
ACK has a separate word released only after both binary ACK and legacy marker durability succeed.
Capture, consumer and replay paths require completed publication plus healthy ownership. An existing
file with no completed word cannot manufacture a lost producer's success. Final terminal and veto
readers require their record completion words too. CI receives no writable mapping or control
channel. The child unmaps inherited root shared memory before dropping UID, and native
`POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT` replaces it while inheriting only stdin/out/err.

The first immutable Bash hook writes context, then **execs the same trusted observer as CI**
in `--job-consume` mode. The stream durably binds this continuation to that original Bash token,
with separate native birth/UID/SID and boot facts. ACK includes the complete original admission,
not only a nonce. The native consumer reads root-owned 0444 data and checks its **own**
`TASK_AUDIT_TOKEN`; a later/reused PID or execution cannot consume the original ACK even when EXIT
delivery is delayed between the publisher's last audit-token check and atomic publication.
Capture/ACK additionally revalidate the exact audit-token dynamic code through Security.framework,
the existing native ancestry/argv/input/socket checks and repeated capture bytes. These supported
calls still need actual qualification; fixtures do not establish their guest behavior.

Original hook/consumer exit, ACK and accepted SDK completion close capture permanently.
Exclusive, durable per-operation observer creation forbids resubscription after death/restart.
Readiness additionally checks current root audit-token dynamic code and independent native
birth/UID/SID/path, under the immutable root owner's no-exec invariant; stale shared words are not
liveness. Denied/unsupported observations veto, rather than using the published token as its own
proof. Publication failure, sequence loss or contradictory evidence retains uncertainty; missing actual
consumer EXIT prevents successful source settlement. The final root record is published only
after actual Listener return and client deletion, and source consistency requires that original
consumer exit evidence. **No tail completeness is claimed**: silence, an empty queue or
`es_sync_client` cannot prove an undetected dropped tail; SDK 27 also calls sync blocks on deletion.
The implementation does not use sync callbacks as a drain receipt. Original-cut native absence,
actual host transport/consumer joins and authenticated terminal association remain separate
mandatory disposal contracts.
Known non-success veto disposal additionally requires certain terminal evidence of the original
hook/consumer EXIT. A source-failure closure or native absence alone cannot qualify that veto;
missing or contradictory original EXIT evidence retains the operation.

Source compilation and explicitly local synthetic state/ACK/publication fixtures are not ES
delivery, continuity, first-hook, exit, legitimate restricted-entitlement, VM or real GitHub qualification.
A bounded local filesystem fixture observes readable single-link bytes before directory fsync, then
proves completion stays false on injected directory/ACK-marker persistence failure. It does not
qualify the actual root mappings or Apple's delivery.
Those access-gated runtime checks and two serial genuine jobs remain required before activation.

Go supplies the actual REST runner/run/attempt/job join and immutable Git commit/tree before native
ACK. PR merge base/head come from ordered host Git parents (second parent = REST head), not writable
event payload. The native owner reconstructs the complete recursive tree and later reads original
extension checkout bytes/modes through no-follow descriptors without running CI Git/tools. That
later consistency check is fail-closed, not authority or a tests-mutate waiver. Automation/editor/fork
inputs retain their separate workflow qualification owners.

Settlement requires the exact terminal association, absent registration, actual transport/consumer
exit and original-cut native quiescence before stopping/deleting only the owned working clone.
A deterministic debugger/integrity veto is non-success, never qualified source: disposal additionally
requires authenticated failed job, actual hook failure/no ACK and the same lifetime/absence proofs.
Idle canceled demand uses two phases: native closes the gate and stops/reobserves only an authenticated
idle Listener with no Worker/capture/ACK, then Go proves offline/non-busy registration removal before
native disposal. Intent cancellation is conveyed only on legitimate unassigned drain/settle; an
actual runner completion closes every action's source window. Busy/unknown runners are never removed.

Recovery resumes exact journaled cloning, starting, qualifying, stopping or deletion against actual
owned inventory. Unlaunched disposal has no nonexistent-checkout requirement. An interrupted warming
phase without its original completed native cut, missing source/association, reused PID, lost transport
or other uncertain cleanup retains the guest/disk/slot/private roots; no force-retire, journal surgery
or capacity-on-error shortcut is provided. Bounded private diagnostics preserve original errors;
untrusted runner logs are limited to 32 regular files, 512 KiB each and 2 MiB total, and are never
included automatically in public evidence.

For controller build/private installation, status, drain/recover and **separate reviewed activation**,
follow the canonical [SDK controller instructions](../scripts/protected-macos-controller/README.md).
Staged installation alone neither activates launchd nor performs API/JIT operations. The host must be
logged in, awake/networked and have usable existing FileVault/keychain/Tart context; this is not a
before-unlock or 24/7 SLA. Controller exit 0 means completed protocol/resource lifecycle, **not a
passing GitHub job**. Server conclusion remains test authority. CLI exits 1/2 indicate failure/usage.

#### Reviewed runner refresh

GitHub's runner update requirement is not waived by a pinned trust policy. Within the documented
30-day update window, verify the new official archive and review hook ordering, supported child paths,
DAP lifetime and .NET/native premises before updating the version, archive hash, all input pins and
root policy coherently. Generate the current maintained manifest with:

```sh
python3 scripts/protected-macos-runner-manifest.py actions-runner-osx-arm64-2.338.0.tar.gz
```

The generator verifies archive identity before producing `protected-macos-runner-integrity.tsv`.
Update its root policy digest and reviewed version/Worker hash together; requalify a credential-free
baseline and source trust, retaining prior proof/rollback artifacts. An automatic update to an
unreviewed Worker cannot authorize capture. No permanent-version, host protection or VM-escape
certification follows from the guest receipts.

## Coverage

The scope owner is `scripts/quality-scope.mjs`. Its inventory is Git-maintained code, including new
untracked files not ignored by Git. Build-owned `dist` and `dist.staging*` outputs are excluded;
node_modules and local ignored runtime/scratch directories are not maintained source. Every maintained
TS/JS file belongs to a compiler/type-resolution project. Root and effective leaf projects must retain
`strict` and `noImplicitReturns`; maintained leaf projects may not use `noCheck`.

TypeScript, effective inherited `checkJs: true` JavaScript and leading `@ts-check` files retain semantic
lint. Other JavaScript retains nonsemantic lint, Promise/import/control-flow rules, formatting and
applicable tests, and remains available to checked consumers for type resolution. The final JSON
override contains exact unchecked-JS paths and disables rules classified type-aware by the **installed
Oxlint metadata**, not by namespace. A stale inventory fails policy until regenerated. Tests and helper
roles are independent of language scope. Compiler diagnostics are tested independently of lint.

Normal lint, fixes, agent output, CI and the editor all use this same root configuration. VS Code uses
the Oxc extension and its supported `oxc.path.tsgolint` setting to select the corrected repository
engine. Run `quality:setup` before starting the editor language server; reload it after patch updates.
Binary settings are relative to the repository as the first workspace folder. Oxc resolves these
paths itself; `${workspaceFolder}` is unsupported and would discard the corrected-engine selection.
The canonical TypeScript command remains `npm run typecheck`; `typecheck:leaves` additionally checks
maintained nested projects using their effective settings.

The auxiliary `scripts/protected-macos-controller` module is Go, not an Oxlint/TypeScript exclusion.
`quality:controller` runs native Go vet, committed-module verification, race tests, a build and actual
CLI help in the real acceptance workflow. Native gofmt owns its source; both root formatting commands
include the corresponding `format:controller` command. Go and the controller remain optional for normal
extension production installation/build. Go tests have their own 600-second deadline; the command owner
allows 11 minutes so startup and that deadline do not get cut off by its default five-minute timeout.
These local checks do not activate the service or certify
live GitHub routing, protected guests or unattended-job settlement.

The root `.oxlintrc.json` is the only approved lint configuration. Policy rejects alternative root
and nested auto-discovery names supported by the pinned CLI (`.oxlintrc.json[c]`,
`oxlint.config.ts`, `oxlint.config.mts`), including ignored configurations beside maintained source.
This prevents silent rule weakening in both CLI and editor discovery; CODEOWNERS covers these paths.

## Production and test contracts

Production limits are modified complexity 10, depth 3, parameters 4, statements 40, function lines 80
and file lines 500 (blank lines and comments excluded). Tests, `test/support` and `test/fixtures` retain
complexity 15, depth 4 and parameters 6, while cohesive suites have no size/statement limits. Declaration
files retain API/safety checks with structural metrics exempt. Native tool/RPC boundary modules alone
retain their required external arity; application-owned operations still use ordinary limits.

Application inputs must be readonly-compatible. Native/SDK permissions use actual package/library/file
origins and CLI isolation probes. They do not freeze native objects or certify every reachable value.
There are no blanket Map/Set/Record/Readonly permissions in the root rule. Raw `ReadonlyMap` and
`ReadonlySet` still allow method reassignment; use `Readonly<ReadonlyMap<K, ReadonlyValue>>` and
`Readonly<ReadonlySet<T>>` when the input contract also prohibits method replacement. Mutable native
containers and mutable contained values remain detectable through the patched engine.

`mutationBoundaries` in `scripts/quality-boundaries.mjs` is the compact canonical record of approved
state/lifecycle owners. `quality:scope --write` materializes exact-file overrides, retaining the complete
native base allowance list (Oxlint replaces rule option arrays). These permissions are not available to
pure readers: use readonly views instead. Owner-specific parameter-property permissions name actual
parameters; other parameters and ordinary mutable data remain checked. Change the registry, not copied
JSON blocks. Policy verifies regeneration and probes origin, file and parameter isolation.
Every boundary file and file-qualified readonly origin must exist, and every allowed name must
identify an actual class, interface or type-alias declaration in that origin. The CLI keeper also
copies and exercises the real runner declaration; synthetic isolation shapes alone do not prove that
an owner path is correct.
File-qualified type aliases must be nongeneric, so an approved fixed native alias cannot silently
become permission for arbitrary mutable application type arguments.

Only fixed **nongeneric** native result/message aliases can receive local file-qualified permissions;
mutable application type arguments are not waived through broad generic SDK names. Framework-owned
node:test registration uses the actual `@types/node/test.d.ts` declarations `test`/`suite`. Ordinary async
calls, local shadows, copied callable types, other packages/files and unawaited `t.test()` remain errors.
Native Promise/PromiseLike readonly input permission is never safe-Promise permission.

## Suppressions and narrow semantic exceptions

Use native, single-rule `oxlint-disable-next-line` comments with a specific immediately preceding
explanation. The AST-based policy ignores strings, regexes, templates and documentation text; blanket,
ESLint-style, unapproved and unexplained suppressions fail. Unused native directives are errors.

Already-authorized single-site classes are required sequencing, intentional control-character
validation, necessary post-await lifecycle guards and a reproduced plain generic callback-result
readonly limitation. Preserve real callback results and interruption tests; do not invent purity or
fake `Readonly<T>` results. No floating-Promise suppression is permitted.

Additional user-approved exceptions are confined to their actual boundary syntax:

- Noncallable JSONSchema `then` data in the exact handwritten schema/report modules.
- Optional native event-bus unsubscribe `void | (() => void)` in the two retained slash adapters.
- Five explicitly typed selected-host SDK namespace loads in native-session/typebox/tui adapters.
  Their computed native URLs preserve actual Node/Jiti host identity; arbitrary assignments, other
  declarations, wrong namespaces and untyped loads remain forbidden. Remove the exception when loader
  declaration identity is preserved and the native qualification probes pass.

Explicit `undefined` arguments are retained only in demonstrated argument-presence/negative-input test
files via `checkArguments: false`; other unnecessary forms remain checked. `@ts-ignore` and `@ts-nocheck`
are forbidden. Described `@ts-expect-error` belongs only in dedicated `.test-d.ts` compiler-negative cases.
Additional relaxations need an exact diagnostic, real contract, narrow scope and positive/negative proof.
CODEOWNERS routes enforcement changes to the repository owner; branch protection remains repository
administration, not a replacement for these executable checks.

## Engines, formatting and generation

Pinned Oxlint/Oxfmt and TypeScript 7 are npm-owned. The separate pinned TypeScript 6 API alias supplies
AST/config APIs absent from TypeScript 7; it is not the compiler gate. Compiler scripts and probes call
`node_modules/typescript/bin/tsc` explicitly: the API alias also advertises `tsc`, so the shared npm bin
shim cannot identify the intended compiler reliably after every install. The native engine recipe, upstream
pins, patches, cache hashes, supported platforms and clean-install evidence are in
[quality-engine.md](quality-engine.md). Never hand-edit installed dependencies. The installer rebuilds
when any patch hash changes and all invocation surfaces use that same cache.

Oxfmt owns supported maintained files with width 100, two spaces, LF, double quotes and no optional
sorting/JSDoc rewriting. npm owns package-lock formatting; generators own schema bytes and build output.
`generate:schemas` regenerates canonical run-contract validators and `check:schemas` verifies freshness.
Unified Go patches are byte-sensitive; only those artifact paths have Git whitespace-context exceptions.
Do not pack code onto fewer lines, move implementation into fixtures, or change snapshots/assertions to
make metrics pass. Review fixes, formatting idempotence and lint/format convergence.

## Verification and reporting

### Responsibility boundaries

The strict cleanup separates responsibilities, not just file lengths:

| Before                                                                                          | Current owner boundary                                                                                                                                                  | Preserved contract                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The detached runner mixed process controls, step execution, status, acceptance and publication. | `RunnerLifecycle` owns cancellation and cleanup; `RunnerMonitor` owns status; `RunnerWorkflow` executes the plan; `completeRunner` publishes finalized evidence.        | Ordered steps, bounded concurrency, sibling evidence, durable completion and process-tree cleanup.                         |
| Foreground execution mixed management commands, preparation, launch and waiting.                | `ForegroundExecutor` prepares one request and selects `ManagementActions` or `InvocationExecution`; the wait owner separately registers, observes and settles receipts. | An accepted launch is not undone by a wait failure; cancellation and supervisor handoff remain distinct.                   |
| History ingestion, querying, watching and IPC shared large implementations.                     | The worker owns admission and background work; source ingestion owns its descriptor/transaction; query modules own paging and selection; IPC validates both directions. | Native journal publication, owner isolation, bounded selected records, cursor freshness and read-only authoritative files. |
| Agents UI forwarded operations through the controller and shared writable task objects.         | The task store owns cache updates; browser and controls expose focused bound ports; conversation components receive readonly observations.                              | Drafts, unread state, paging, native clicks, full metadata and session-generation guards.                                  |
| Parent and child runtimes duplicated final-result adaptation and reload cleanup.                | Shared adapters perform the native result copy once; each runtime owns its reset, subscriptions and shutdown.                                                           | Native usage accounting, persisted notices, reload recovery and joining parent reset before disposal.                      |

The application executor now accepts one named request object, with its callers migrated together.
Native Pi callbacks retain their required SDK signatures. Existing public compatibility exports remain;
new private helpers are not exported merely to move lines or enable tests.

`test/quality/*.test.mjs` invokes the installed native CLI against disposable projects. Expected rule IDs,
locations, positive boundaries and failure statuses are independent of the checker. Fixtures are strings
materialized outside normal compilation. Tests cover language opt-in, inherited projects, compiler-only
errors, production/test limits, rule options, comment directives, native declarations, safe-call and
mutation-owner isolation, and native-container contents/method ownership.

`quality:sabotage` starts from a clean committed integrated revision, installs its own lockfile-resolved
dependencies in a disposable detached worktree, runs baseline **real `npm run ci`**,
then injects a syntactic lint violation, semantic violation, compiler error, formatting error and wrong
existing safe-call declaration path in the isolated installed-CLI probe. Production policy stays intact
for that last control, so static checks cannot preempt the intended allowance-isolation failure.
It requires the intended error, retains logs in the OS temporary directory and removes its own worktree
without touching other work. A failing baseline is not successful sabotage proof: finish integrated
source cleanup first.

Report configuration-only changes, checker-integrity corrections, formatting, maintainability changes,
fixture repairs and actual runtime bug fixes separately. Include the exact commands/results and any
unperformed integrated/native qualification. Lower diagnostic counts alone do not establish runtime bug
fixes or completion. The complete integrated acceptance workflow must pass with zero errors/warnings.
