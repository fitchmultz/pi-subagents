# Single-agent rebuild: evidence and acceptance

## Diagnosis before design

Baseline: `1646ab895e25fb56847ad669733c55807bc8ff3c` (0.49.1).

The investigation inspected package source, the user's twelve agent overrides,
effective profile discovery, the installed Pi runtime, and pi-intercom's actual
broker, routing, native delivery, and persistence owners. The replacement was not
designed until the following installed-package failure had been reproduced.

### Live information-loss reproduction

Two real local Pi children were invoked through the installed `delegate` tool:

1. A fresh `worker`, with `async:false` and `output:false`, was asked to return
   exactly `CALIBRATION_FACT=amber-otter-7319`, without tools or explanation.
   Its actual returned response was that exact line.
2. A second `worker`, with `context:"fork"`, `async:false`, and `output:false`,
   was asked to find that line in its inherited conversation. Filesystem reads,
   history search, tools, and guessing were prohibited. It was instructed to
   return `CALIBRATION_FACT_NOT_VISIBLE` if the line was absent.
   Its actual returned response was `CALIBRATION_FACT_NOT_VISIBLE`.

Both used the user's effective worker override. This was live model execution,
not a mocked context-filter assertion. It proves the observed failure for that
launch; the source establishes the deterministic mechanism:

- `src/runs/shared/child-context-filter.ts` removes prior `delegate`, `subagent`,
  `agent_runs`, and `load_subagent` tool results and assistant calls from leaf
  children. It also removes several custom result/notification message types.
- `src/runs/shared/subagent-prompt-runtime.ts` applies that filter to provider
  context. The native journal remains intact, so inspecting the saved journal
  alone would miss the loss experienced by the child model.

The filter conflates orchestration authority with the evidence produced by
orchestration. Removing access to a spawning tool does not require removing its
historical results.

### Why overrides fight the profile system

`src/agents/agent-selection.ts` uses whole-object replacement: bundled/package
profiles, then user profiles, then project profiles. User Markdown does **not**
append its body to the bundled body. The twelve user files therefore shadow all
twelve same-named built-ins, including their model, effort, output, and prompt
configuration.

`src/agents/builtin-overrides.ts` applies settings-based overrides to built-ins
_before_ user definitions replace them. The user's settings also contain five
retired profile names, with no effect on current executable profiles. There are
multiple configuration paths to reason about, not one coherent inherited profile.

The launch path adds further policy outside those files:

- `pi-args.ts` prefixes the task and supplies the profile's system-prompt body.
- `single-output.ts` can append a file-writing instruction.
- `subagent-prompt-runtime.ts` injects child-role instructions independently.

Deleting only the bundled Markdown bodies would leave those behaviors intact.
No user override, model configuration, credential, or active installation was
modified during diagnosis.

## Baseline and shrink budget

Counts are physical lines (`len(text.splitlines())`) in Git-tracked files at the
baseline, not generated build output or `node_modules`.

| Surface                                              |                   Baseline |        Acceptance ceiling |
| ---------------------------------------------------- | -------------------------: | ------------------------: |
| Bundled profiles                                     |                         12 |     1 implicit agent type |
| Canned profile-body lines                            |          Nonzero in all 12 |                         0 |
| Effective profiles on investigated installation      |                         14 |      No profile discovery |
| Package extension entries                            |                          2 |                         1 |
| General/coordination tools                           |                          7 |                         3 |
| Conditional structured-output tool                   |               1 additional |                   Removed |
| TypeScript under `src/`                              |   84,031 lines / 473 files |              16,000 lines |
| Generated source schema                              |               13,671 lines | Included in total ceiling |
| Production scripts                                   |                3,163 lines | Included in total ceiling |
| Generated validator under `generated/`               | 30 lines / 1,705,064 bytes | Included in total ceiling |
| Source + generated code/schemas + production scripts |              100,895 lines |              20,000 lines |
| Same production surface, UTF-8 bytes                 |            5,015,305 bytes |           1,048,576 bytes |
| Tests and fixtures                                   |   95,666 lines / 211 files |         No deletion quota |

The source ceiling is an 80.96% reduction; the broader line ceiling is an 80.18%
reduction. The additional byte ceiling prevents hiding complexity in minified code. Moving machinery into scripts, generated schemas, or packaged assets
must not satisfy the budget. Tests are counted separately so preserving strong
boundary proof is not penalized.

The seven original general/coordination tool names are `delegate`, `agent_runs`,
`load_subagent`, `subagent`, `intercom`, `load_intercom`, and `contact_supervisor`.
`structured_output` is conditionally registered in children. Effective profile
discovery included two profiles contributed by other packages; those packages are
not owned by this change.

## User-confirmed product design

One main agent and one level of children form a collaboration group. Each pair
within a group can communicate directly: main-to-child and sibling-to-sibling.
Main agents can discover, message, and read the last response of other mains.
Children cannot discover or address another group's agents, even by exact ID.
Only mains can spawn; children cannot create nested subagents.

Group membership is independent of project, cwd, and agent directory. A shared
local broker connects sessions under the same OS account. The hierarchy is an
extension coordination rule, not a security sandbox against other same-user
processes.

The invoking agent supplies the entire child assignment. There is no profile
body, model fallback catalog, role picker, chain/fanout DSL, or hidden instruction
to write a canned report. Native Pi, project, and tool instructions still apply.
Explicit forked context retains the native conversation, including prior tool
results. Communication offers discovery, messaging, and a non-waking read of the
last completed assistant response with full, stable retrieval of large responses.

The three tools are `delegate`, `agent_runs`, and `intercom`.
Transport acceptance, native queue admission, journal publication, model
consumption, completion, and process exit remain distinct facts.

The user also authorized rebuilding `fitchmultz/grok-pi-bridge` to match the new
surface. Obsolete remote lifecycle/catalog/transcript/group APIs need not be kept
merely for compatibility. Authenticated messaging, durable mailbox transfer,
ACK semantics, and unattended Grok wake/recovery remain required. The companion
change is separately reviewed; neither repository change authorizes deployment
or restarting the live bridge.

## Established intercom contracts

These existing contracts, rather than new naming or conflict policy, govern the
replacement:

- Native peer identity is `pi-` plus the first 32 hexadecimal SHA-256 characters
  of the native session ID. A live requested-ID collision receives a distinct
  broker ID; it does not replace or merge the first connection.
- Display names are mutable and nonunique. Exact IDs resolve first. Otherwise,
  exact names and sufficiently long ID prefixes are resolved together; ambiguity
  is rejected. Displayed targets lengthen to avoid collisions.
- Default live messages steer. Explicit queued and passive delivery have different
  semantics. Passive delivery does not wake the model.
- Broker acceptance means the router accepted/wrote the message. It does not prove
  recipient journal persistence, model consumption, a reply, or task completion.
- Recipient journal checkpoints and native receipts own replay decisions.
- An unhealthy socket does not authorize killing a possibly live broker.
  Ownership, directory/socket permissions, framing limits, and conservative PID
  identity checks remain mandatory.

The old namespace is agent-directory-dependent. The approved change is one shared
per-OS-user namespace, not silently combining old brokers or killing their owners.
Old connections remain untouched; sessions join the new topology when they load
the new extension. Explicit private runtime configuration remains available for
intentionally isolated deployments and verification.

## Test-transfer gates

Existing tests remain until their distinct required assertions are preserved at
their actual boundaries. Feature retirement must be distinguished from duplicate
test removal. An inventory or a passing helper mock is not transfer evidence.

| Required boundary        | Original primary owners                                                                   | Assertions the keeper must retain                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native launch/completion | `native-async-host`, native parent/child process fixtures                                 | One native launch receipt before actual completion; one child start; separate later notification; fresh-parent recovery; crashes immediately before/after append; literal output; no fabricated tool usage             |
| Native queued receipt    | `native-completion-ownership`                                                             | Queue admission is not published receipt; dropped and retained queues, abort/reload, pending beyond TTL; negative checks before releasing held turn; published receipt reconciles exactly once                         |
| Cold legacy recovery     | `native-legacy-completion` fixture                                                        | SIGKILL with sole recovery input; no invented ownership; consume input only after actual publication; reopen does not replay                                                                                           |
| Filesystem publication   | `session-resume-cost`, `storage-owner-boundaries`, `journal-reader`                       | LF publication, torn tails, strict malformed data, externally changed journal, same-size/same-stamp replacement, foreign owner refusal, independently specified IDs/usage                                              |
| Native shutdown          | `native-extension-shutdown`, completion shutdown cases                                    | Real runtime disposal waits for admitted filesystem/delivery work; closes watchers; stale generations neither publish nor delete successor input                                                                       |
| Continuation             | `native-run-ownership`, `native-delegation-lifecycle`, `owned-run-wait`, `output-revival` | Saved conversation and frozen launch reused; successor identity; no duplicate launch; no fork/foreign adoption; existing-wait abort preserves producer; immutable predecessor output; uncertain launch claims retained |
| Process stop             | `orphan-stop`, `process-lifecycle`                                                        | Real child/descendant readiness before crash/stop; birth-identity refusal; request acknowledgment not exit; actual exit controls terminal state                                                                        |
| Native intercom          | `pi-intercom-native-replay`                                                               | Actual provider visibility; passive no wake; steer/queue distinctions; clear/retain/abort/reload/compaction; fresh-process recovery; no fork adoption; shutdown and response obligations                               |
| Broker safety            | `pi-intercom-spawn`, `paths`, `framing`, `broker`, lifecycle guards                       | Live/EPERM PID never killed; owned nonsymlink paths; bounded byte framing; transactional snapshots; actual processing barriers; legacy broker left untouched                                                           |
| Grok transport           | Bridge delivery/wake suites and companion receipt/realtime suites                         | Credential-derived identity/revocation; durable mailbox then consumer fsync before ACK; paging, dedupe/tombstones; unknown lost response; passive no wake; durable wake reservations/recovery                          |

Expected values must be independently specified. Negative assertions require an
observed publication, native queue state, or processing barrier—not elapsed time.
No production exports or injection points may be added solely to make tests easy.

## Qualification and delivery

Selected official target: published Pi 1.3.0. The development four-package cohort
is updated together in the committed npm lockfile. The installed/intended fork is
Pi 1.3.0 at `997a2575e0dde7c6690024184feec970d395f9b4`, using Node 24.22.0.
Initial lane qualification used build `882876dae4dc6e33`; final integrated local
qualification used build `127d6b7a5b2492a2`. Equal version strings do not qualify both
hosts. The existing support floor must not be raised or bypassed to pass checks.

Local checks are narrow native/process tests plus `npm run lint`,
`npm run format:check`, and `npm run typecheck`. Full `npm run ci` runs in hosted
CI. Final acceptance additionally requires real local Pi agents on the new
single-profile surface, including different agent directories, to discover and
exchange messages with the confirmed hierarchy and read last responses without
waking recipients.

### Integrated local evidence

- `npm run check:size`: 13,290 source lines; 15,986 total production lines;
  529,900 production bytes. Relative to baseline, reductions are 84.18%, 84.16%,
  and 89.43%, respectively. All three ceilings pass without a distribution
  allowlist concealing the retired engine.
- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, and
  `git diff --check` pass. The committed lockfile's production audit reports zero
  vulnerabilities. Obsolete checker exceptions were removed, not relaxed.
- `npm run smoke:package` and `npm run smoke:install` pass separately with official
  Pi 1.3.0 and the intended fork's actual module graphs. Packed runtime-only and
  standalone probes execute a real native child, tool result, and completion;
  they expose exactly the three package tools and no profile resources.
- 109 focused tests pass with no skips on each host: native agent lifecycle,
  intercom replay, actual editor receipts, saved-input and receipt filesystem
  boundaries, bounded journal/accounting reads, atomic storage, and process
  ownership. The broader suite runs only in hosted CI.
- `node scripts/real-pi-smoke.mjs --llm-full` passes on the pinned fork CLI with
  real model execution. Foreground, async launch/completion/exit, forked tool-result
  evidence, and continuation all pass. The forked child can now read the preceding
  child's literal calibration fact without tools or filesystem access. All 21
  saved parent/child assistant responses used the explicitly selected model.
- A separate real-model topology run used two persistent native Pi mains in
  different agent directories and two actual delegated children. The mains
  discovered each other and consumed messages in both directions; siblings
  discovered and exchanged a message consumed by the continued child. Child-to-
  foreign-main and foreign-main-to-child sends were denied even with exact IDs.
  Native recipient publication was observed before checking consumption. `last`
  returned completed responses without another recipient model call. Every owned
  host, child, private broker, and temporary credential copy was cleaned up.
- Early qualification failures were repaired, not hidden: the package guard
  caught an omitted dynamic actor entry; a synthetic probe selected an unintended
  default provider and received HTTP 402 without a paid completion. The repaired
  deterministic probe asserts the exact faux model before prompting, denies
  network access, and verifies zero network attempts. Live inference is confined
  to the separately opted-in acceptance runs.

This document records evidence and acceptance gates; local success alone is not a
claim that hosted qualification and delivery are complete. Ready-for-review PRs, green hosted
checks, applicable review remediation/Greptile rating, and owned-worktree/process
cleanup are delivery requirements. Publication, runtime installation, and bridge
deployment are not performed implicitly.
