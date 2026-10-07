# Protected Mac SDK controller

This auxiliary Go executable is the repository-scoped, capacity-one control plane for
`fitchmultz/pi-subagents`. It imports the official `actions/scaleset` client/listener at
**e6daac702355cdb5b880b4fbdcf6d85dcd9e48e5** (unreleased Public Preview, MIT), not released
v0.4.0. Go 1.27.1 is the project toolchain; the SDK declares minimum 1.26.3.
This module is optional for normal extension installation/build.

## Build and checks

```sh
cd scripts/protected-macos-controller
go mod download
go mod verify
go vet ./...
go test -race -count=1 ./...
go build -trimpath -o /tmp/protected-macos-controller .
/tmp/protected-macos-controller --help
test -z "$(gofmt -l *.go)"
```

Commit `go.mod`/`go.sum`; do not use `@latest` in acceptance or deployment. Tests use
actual imported SDK client/session/listener over controlled TLS HTTP, filesystem
atomic publication and kernel flock, an actual cold-crashed process, and an attached
NDJSON subprocess. They do **not** claim real GitHub routing, native guest protection,
pre-hook trust, server session expiry, service activation or automatic live releases.
Parent integration must run these commands in actual CI, not an ignored Go scope.

## Ownership and phases

- SDK: registration/admin-token refresh, message sessions, long poll, acquisition,
  queue-token refresh and ACK. The narrow `listener.Client` wrapper bounds actual SDK
  `DeleteMessage` to 30 seconds despite upstream `WithoutCancel`; no copied message pump.
- Go: `controller.guard` (never unlinked, kernel-exclusive, opened close-on-exec so the
  native child never inherits it and a cold Go exit frees it while native lives) and `controller.json`
  (private, atomic replacement, file and directory fsync). This journal records SDK
  acquisition intent/results, returned runner identity, assignment, frozen source and
  lifecycle intent; it is **not** a second native VM journal.
- Native `protected-macos-ci.mjs controller --state …`: one attached per-job NDJSON
  process holds its independent native guard and owns all Tart, pinned SSH, protected
  guest/process/cut/source-byte verification, native per-job journal and disposal.
  No guest code runs on the desktop. Neither listener error nor shutdown cancels Tart.

A physical slot includes preparing, JIT registration, idle/assigned, settlement and
retained uncertainty. `Scale` durably accepts full messages before returning to the SDK
ACK, independently of the asynchronous native lifecycle. Every wanted `JobAvailable`
(whole batches, and demand arriving while the slot is occupied) is journaled as an
in-flight acquisition and passed to the SDK `AcquireJobs`; there is no offer-count
ceiling and no reliance on redelivery to a later session. Invalid or foreign entries
(identity, workflow source or the four labels) are explicitly not acquired
(`demandRejection: rejected-invalid-demand`) without rejecting the rest of the message.
The only size limit is the private journal input bound (2 MiB, the same bound every
private JSON read uses): a state the next owner could not read back is refused before
publication, so the message is neither journaled nor ACKed and the journal stays
usable. That resource failure is a documented certainty ceiling, not a server
rejection. A `JobAssigned` is acquired demand; a
non-duplicate offer or assignment of a request observed complete earlier reopens it (the
SDK documents canceled and requeued attempts). Attempts are durable before the call:
only a first-attempt omission is an explicit rejection; after a lost response an
omission stays ambiguous until `JobAssigned`, a later acquisition or the exact
completion resolves it. No `AcquireJobs` is issued while the active slot has a
`retained` diagnostic (source, identity or native uncertainty); offers stay journaled and
are acquired by the first poll after progress clears it. The SDK documents every
message's statistics as current, with `TotalAssignedJobs` counting waiting and running
jobs, while a new session replays no job messages. The durable receipt identifies a
delivery by message ID and body **excluding** statistics, which the SDK refreshes on every
redelivery of an unACKed message: a redelivered body applies its current statistics but
never re-runs its lifecycle or offers. A message (or session initial message) with any
negative available, acquired, assigned, running or registered count is refused unACKed
with no journal change. Statistics with nothing acquired or
assigned (`TotalAcquiredJobs == TotalAssignedJobs == 0`) therefore retire acquired and
ambiguous entries, also while a slot is active: their cancellation was lost. They are
applied before the message's own lifecycle and offers. Offered-only demand stays; the
active slot, its intent and terminal proofs are untouched and nothing is marked complete.
A slot is admitted only while none exists and capacity is **wanted**: acquired demand not
contradicted by a late start, or authoritative statistics (`TotalAssignedJobs >
TotalRunningJobs`), and no drain or shutdown; cached statistics are re-evaluated on
every poll, including nil long-poll timeouts. The same rule ends an occupied slot that no
longer serves anything (see unneeded slots below). A release marks the cached statistics as
predating it: the next slot waits (`admission: awaiting-current-statistics`) for a
message's statistics or the scale-set read below, so old demand canceled while the slot
was occupied never starts a phantom runner. Aggregate statistics cannot say
whose registration they count, so any `TotalRegisteredRunners > 0` blocks admission
(`admission: blocked-registered-runner`) until fresh statistics show none; a released
own runner is never subtracted and a foreign registration is never waived. The listener
advertises capacity 0 whenever the physical slot is occupied, draining or stopping, and
while such a count or pre-release statistics hold a free slot. The SDK's nil long-poll
timeout carries no statistics and a session reports initial statistics once, so on each
nil poll with a free slot so held the owner reads the scale set by ID through the SDK
(`GetRunnerScaleSetByID`). Its statistics are applied (including the zero retirement
above) only for the exact owned ID, name and four labels with non-negative counts; a
failed or invalid read keeps the block, is shown as `listenerFailure: statistics-refresh:
<code>` and is retried on the next nil poll. After a release the next slot can therefore
wait up to one long poll (about 50 s). Only `Scale` writes statistics, serially, so no older observation
overwrites a newer one. Real GitHub semantics of these counts remain to be qualified.
Only an exactly observed terminal (matching `JobCompleted`, or a proved no-job/veto
terminal) makes a request ineligible; unlaunched recovery keeps the request acquired for
the next slot. Exact durable runner ID and name are checked before request history.
A completed/canceled message is only a settlement signal, never native disposal proof.

A canceled admitted request with no job started on the runner is **intent
cancellation**, kept apart from the runner's job terminal. Only a `JobCompleted` naming no
runner is one; a terminal naming another (for example a released) runner is that runner's
job and only request bookkeeping, never this runner's no-job authority. After all of the message's
and acquisition's effects, other acquired or ambiguous demand retargets the idle slot.
An exact-runner `JobStarted` supersedes it until it has been conveyed to native. Native
receives it as `completion` only on the no-job `drain`/`settle` (or unlaunched disposal)
frame, which durably marks it conveyed in the same journal transaction; a later start on
that runner is then a contradiction that retains the slot.

Every release journals the exact disposed runner ID/name (`releasedRunners`, the last 32).
A later `JobStarted` for such a runner is a **late start**: the message is accepted and
ACKed, and its request is kept acquired with `lateStartRunner` (status `lateStartDemand`) —
not a new assignment, completion or cancellation. Such a request is never admitted or
retargeted to; an unconveyed, unassigned active intent on it moves to other acquired demand,
or is dropped. Only its exact `JobCompleted` (matched by request, run, job and repository,
whichever runner it names), a `JobAssigned` or zero acquired+assigned statistics reconcile
it; none of them is a cancellation or completion of the current runner. Unknown runner
identities still refuse the message.

**Unneeded slots exit by themselves.** When capacity is no longer wanted (above; a request
started on another runner counts as running) an unassigned slot is ended without inventing
a cancellation or completion: before JIT through unlaunched disposal (checked when prepared
and again right before minting), and once launched through the existing native idle EOF
recovery below. Go then sends the same live native owner EOF once, under the completion and
start ordering locks, so a fact accepted before it keeps the slot, and awaits that owner's
actual exit. Statistics never prove idleness: only native's root-proved known-idle stop
yields `interruptedUnassigned`; a busy, assigned or unknown lifetime keeps its owner and the
slot waits. Acquired demand stays acquired for the next slot. Operator drain and shutdown
reclaim an idle unassigned slot the same way.

Prepare/prove the clean clone **before** SDK JIT. Record returned runner ID/name immediately,
verify scale-set/default group/four labels and REST readiness separately. JIT exists only
in memory and private pipe stdin, never argv, journal, logs or baseline. `jit-intent`
means the server may have registered the runner: every mint attempt first performs the
exact SDK name lookup. A found registration is journaled and disposed; with authenticated
absence, an already accepted completion disposes the prepared clone without minting.
Neither a crash nor a lost JIT response ever mints a second JIT. The SDK update policy permits official updates in disposable guests; the native
pre-job trust gate must reject unreviewed actual Worker versions/hashes before ACK.

Only authenticated terminal job identity, ended owned listener/consumers, absent/nonbusy
owned registration, frozen source consistency and actual native disposal release a slot.
No prefix sweep, busy DELETE, name-only signal, diagnostic root deletion, capacity-on-error
release, guest reuse or local workflow demand queue exists. Native settlement owns safe
pre-registration recovery with **no nonexistent checkout requirement**.
Every DELETE needs the exact authenticated ID/name with explicit `busy:false` and offline,
plus the caller's fresh journal contradiction check. Any due GitHub App installation-token
refresh is completed (through `ghinstallation`'s `Token`/`Expiry`) before that check, so the
DELETE never waits on authentication after it. Connection acquisition, DNS, TLS, network,
client and server waits still follow the check: GitHub has no conditional runner DELETE, so
the check→server DELETE interval remains an external window (the native listener is already
stopped), and the journal is never locked across external I/O. Facts arriving after
release are late starts (above), not covered by pre-release checks.
When an SDK runner ID was returned but no JIT reached the listener, Go first proves the
exact registration absent (offline, non-busy DELETE, REST 404 and an SDK name lookup).
It then sends `settle` with `terminal{runnerId,runnerName,registrationAbsent:true}`.
Run and job fields stay zero, and no source or completed job is invented.

Three other settlements never produce a qualified source:

- **Idle/no-job:** an exact SDK `canceled` completion for the acquired request with no
  `JobStarted` and no source. REST `busy:false` is not proof of idleness, and a missing or
  null REST `busy` retains the slot: every DELETE, idle drain and unlaunched launch requires
  explicit `busy:false` (absence is proved by REST 404 plus the SDK name lookup). Native `drain`
  receives `{noJob,canceled,requestId,runId,runnerId,runnerName,registrationAbsent:false}`.
  It closes the pre-job gate, proves the same idle listener with no Worker, capture or
  ACK, then stops and reobserves only that listener. Go then deletes the exact offline,
  non-busy registration and sends `settle` with `registrationAbsent:true`. The fresh slot
  must still hold exactly that cancellation and no assignment, source or veto when each
  `drain`/`settle` frame is built (under the ordering locks below), after the native drain
  reply, right before DELETE, atomically when recording the terminal and `disposed`, and in
  the release update; an exact-runner start after the cancellation was conveyed retains the
  slot. Disposition is `canceled-unassigned`.
- **Interrupted-unassigned (native idle EOF):** a cold Go exit gives the native owner EOF.
  Only when root proves a launched, genuinely idle listener (no capture, bind, ACK, veto,
  completion or known assignment) does native stop it, observe the actual transport end and
  journal `idle-interrupted`, then exit; it never deletes the guest, registration or demand.
  The next Go owner sees `result.interruptedUnassigned` with `transportEnded` and phase
  `idle-interrupted` on `capture`/`status`, journals phase `interrupted`, and retains the
  slot if it has (or later gains) an assignment, source, completion, intent cancellation or
  veto. Before DELETE native must re-prove the interruption, and REST must show the exact
  registration with explicit `busy:false` and offline (or REST 404 plus SDK name absence).
  `settle` then carries `{interruptedUnassigned,noJob,runnerId,runnerName,
  registrationAbsent:true}` with no request, run, job, conclusion or cancellation. Native
  must return `disposed`, `transportEnded` and `interruptedUnassigned` without
  `sourceVerified`/`vetoVerified`. The fresh slot is rechecked for those job facts after each
  native reply, right before DELETE (after the REST reads), when recording `disposed` and in
  the release update after the actual owner exit; an interrupted slot's cancellation is
  never retargeted. Disposition is `interrupted-unassigned-recovery`; no
  request is completed, so the acquired intent is served by the next slot.
- **Deterministic guard veto:** a native `{code:debugger|integrity,receiptHash,hookFailed,
  noAck,windowClosed}` receipt is persisted first (`veto-settling`). Settlement requires an
  unchanged receipt, ended transport and a REST job joined to the unique owned runner ID
  and name. The job must be completed and non-success with a matching run attempt. Native
  must return `vetoVerified` and never `sourceVerified`. Disposition is
  `guard-vetoed-failure`, not green.

An assigned completion without a frozen source or veto stays retained as uncertainty.
Source publication re-checks the journal: a completion accepted during REST resolution
prevents the freeze. Native requests are built from the current journal under one
ordering lock that `Scale` also takes to publish a completion. The lock is released
when the frame write returns, which is the linearization point: `bind` either carries an
already accepted completion (native closes capture and refuses ACK), was wholly in the
pipe before the completion became durable and was ACKed, or was abandoned unterminated.
Every no-job `drain`/`settle` frame is validated against the current slot under a second
lock that `Scale` takes to publish a `JobStarted`, held until its write returns: a start is
either durable first and vetoes the frame, published (and ACKed) only after the whole frame
is in the pipe, or the frame is abandoned unterminated. Starts never wait behind other
frames. A committed native action is not undone; Go's later fresh checks retain the slot.
Writes run in 50 ms slices; while native is not reading and any completion (even for an
unrelated request) is waiting, the frame is abandoned and the owner poisoned (native acts only on newline-terminated frames),
so completion polling and ACK never wait on native. That abort scope is an accepted
fail-closed certainty ceiling; narrowing it needs a proven relevant-completion ordering. Recovery rebuilds the request from the
journal. Only a native veto then settles; otherwise the slot is retained.
A bound job's SDK completion is only a signal: a new SDK session replays statistics,
not job messages, so a lost completion must not strand the slot. While bound, Go polls
native `status`; actual official transport exit starts the same settlement (exact REST
terminal association, offline/absent registration, native `sourceVerified` disposal),
and that proven terminal completes the bound request. No SDK completion is invented.

One native exchange is outstanding at a time. A deadline never resends, cancels or starts
another owner: the next call first consumes and validates the original reply by ID, then
dispatches its own action. Release sends EOF once and resumes waiting for the same owner.
A poisoned live owner (malformed or mismatched reply, failed or abandoned write) gets the
same single EOF and is retained until its actual exit; only then does a new owner start.

Lifecycle problems are journaled as a bounded diagnostic `{code,kind}` with Go-owned static
codes or HTTP status classes. `waiting` is expected external progress (live transport, REST
publication or terminal lag, registration not yet offline/absent, pending native reply);
`transient` is a retried API/network/deadline failure (REST 5xx/429/rate limits, SDK
queue-token expiry, network, deadline); `unavailable` is rejected credentials or
authorization (SDK unauthorized, REST 401/403); `retained` is unknown or contradictory
evidence that never auto-releases (other SDK sentinels and REST 4xx). The SDK's retrying
transport reports exhausted retryable responses (429, 5xx except 501) as typed transport
errors (`network`/`transient`); its other HTTP failures carry no exported status, so
they stay `unclassified`/`retained` rather than parsing error text. A queue 401 that
survives the SDK's session refresh wraps both the queue-token and generic 401 identities
and is classified by the more specific queue-token expiry. A `retained` diagnostic is
sticky: a later `waiting`/`transient`/`unavailable` failure is kept beside it as
`latestDiagnostic` and never replaces it, so acquisition stays held. A successful
same-phase wait (no capture yet, live transport, a status reply) is not certainty: only an
actual lifecycle phase advance or the slot's release clears both; other diagnostics clear
on any successful step. Only an unrecoverable journal failure
stops the worker, with or without an owned slot (it checks the sticky failure every
tick); `run` then exits non-zero with that error joined to any SDK close error so
launchd restarts the owner.

Normal SDK restart closes the actual owned in-memory session before replacing it. Cold
crash reacquires kernel ownership and preserves journals; typed session-create conflict
uses bounded actual SDK calls and cancelable cooldown until **server success** allows
another session. There is no guessed expiry, exception-ID parsing, SDK private hydration,
HTTP interception or custom session DELETE. Real GitHub cold-crash/409 recovery remains
an explicit live qualification requirement.

## Assignment source

The SDK has no checkout SHA/tree/attempt. REST job IDs are resolved from the exact SDK
runner ID/name plus run and attempt; opaque SDK `JobID` is never coerced to a REST ID.
The native first pre-job capture is held before public pre/actions, then joined to bounded
host-side official GitHub SDK run/attempt/job and immutable Git commit/tree lookups.
The immutable recursive tree must be complete, bounded, nonsubmodule and path/mode safe.
The native owner receives blob IDs and modes 100644/100755/120000, freezes the expectation
before ACK, and independently checks real source bytes without executing CI Git/tools.

For PRs, checkout is the actual captured synthetic-merge SHA/ref, not REST head SHA or a
moving current merge ref. Host Git ordered parents provide original base and head; the
second parent must equal REST run head. CI-writable event payload base/head is diagnostic
only. Push, schedule, dispatch and reusable callers keep their actual caller event/source
semantics; reruns are joined to the exact REST attempt. Display-name formatting and SDK
event strings do not substitute for authoritative runner/run/attempt association.

The source binding covers the extension checkout. Separately resolved automation/editor/
fork inputs retain their existing workflow qualification owners; this binding does not
pretend to authenticate job outputs it cannot see. Server terminal conclusion remains
test authority: successful controller/native disposal does not imply green tests.

The native owner must prove fixed `env -i` runner launch, required immutable hook variable,
no `.env`/shell/PATH/DOTNET injection, authentic actual hook/Worker identity and reviewed
version/hash, debugger exclusion, bounded hold and permanent capture-window closure.
An immutable hook/PID artifact alone does not prove that pre-hook DAP code never ran.
Source authentication and latency inside unchanged job budgets remain **unqualified until
those native/live checks pass**. No fake receipt or guest self-attestation substitutes.

## Private configuration and inactive installation

Create a user-owned 0700 root and private 0600 configuration, outside CI-writable paths:

```json
{
  "version": 1,
  "root": "/absolute/private/controller-root",
  "nativeState": "/absolute/private/native-root/state.json",
  "node": "/absolute/reviewed/node",
  "helper": "/absolute/reviewed/source/scripts/protected-macos-ci.mjs",
  "authFile": "/absolute/private/credentials.json"
}
```

Credential JSON is **either** `{"pat":"…"}` **or** a repository-selected GitHub App's
`{"appId":123,"clientId":"…","installationId":456,"privateKey":"PEM…"}`. Use an existing
suitable fine-grained PAT or App with repository Administration read/write, Actions read
and Contents read. SDK owns App/admin refresh; `ghinstallation` owns REST App refresh.
Never put credentials in shell argv or copy them into the guest. No credentials are
included in source/evidence. Native state/baseline/keychain access must already be valid.

```sh
/tmp/protected-macos-controller install --config /absolute/private/config-input.json
/tmp/protected-macos-controller status --config /absolute/private/controller-root/config.json
/tmp/protected-macos-controller drain --config /absolute/private/controller-root/config.json
/tmp/protected-macos-controller recover --config /absolute/private/controller-root/config.json
```

`install` copies the built executable/config and **stages** a uniquely named 0600 plist in
`<root>/launchd/` plus 0600 logs. It never writes `~/Library/LaunchAgents`, invokes
launchctl, GitHub APIs, registration or native provisioning, so nothing starts at the next
login; it refuses to replace an existing deployment. Preserve working rollback artifacts;
deploy a fresh private root for a reviewed upgrade. Activation is a separate parent-owned
reviewed-source step using the two commands `install` prints:

```sh
cp -n '<root>/launchd/<label>.plist' "$HOME/Library/LaunchAgents/<label>.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/<label>.plist"
```

`run` is operational, not a dry-run.

`status` is sanitized **local journal evidence**, not a live routing/readiness certificate.
It reports `configuredMaxRunners: 1` separately from `availableCapacity` (the listener's
capacity rule: 0 while occupied, draining, held by a registration count, uninitialized or
with no established listener),
the last local `listenerUp`/`listenerFailure` observation (scale-set, session, typed 409
cooldown, listener exit or registration refresh; cleared on an established session or a
successful refresh), the active diagnostic and any lesser `latestDiagnostic`,
admission block, demand rejection, in-flight demand count and any rejected private
control request (`invalid-private-control`).
`drain` stops new acquisitions while the same service continues current settlement and
waits for `recover`; `recover` resumes safe journal reconciliation, never force deletion.
SIGINT/SIGTERM stop admission and wait for actual settlement before closing SDK session.
Under drain or shutdown an unassigned slot is reclaimed as an unneeded slot (above); an
assigned or uncertain one keeps its full lifetime.
The staged plist sets no `ExitTimeOut`, so launchd's system-defined timeout applies: on
logout or `bootout` it SIGKILLs the controller after SIGTERM, possibly before long
settlement. That cold exit is the same recovery path as a crash (journal kept, native
gets EOF and retains or proves interruption); drain is not guaranteed to finish in place.
Native EOF/error retains uncertain ownership; never erase private state to free capacity.

A user LaunchAgent requires login and an awake/networked host with usable existing
FileVault/keychain/Tart context. This is not before-unlock availability or a 24/7 SLA.
No host privileged daemon, privacy/SIP/CSR, Internet Sharing, Softnet, settings or reboot
change is part of this module. Capacity one automatically replenishes distinct PR/main/
reusable-release jobs after proven disposal; real repeated-job qualification is pending.
