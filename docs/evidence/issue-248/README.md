# Session attach measurement for issue 248

## Result

The candidate makes the RPC session responsive sooner on this synthetic Linux fixture.
It moves cold completion-receipt work to the first tool or existing scanner, rather than removing all recovery work.
It does not establish an installed macOS speedup.

Five alternating A/B pairs used official Pi 1.4.0, Node 24.22.1, and the committed dependency graph.
Each fresh CLI process switched into a synthetic 42,594,922-byte native v3 journal with 5,180 entries and 1,000 completed runs.
All runs returned the correct session ID and all 1,000 runs, with a 50-row first page and no errors.
Every process exited normally and left its attachment detached.

| Boundary, milliseconds                                | Baseline median |   Baseline range | Candidate median |  Candidate range |
| ----------------------------------------------------- | --------------: | ---------------: | ---------------: | ---------------: |
| RPC `switch_session` response                         |          754.27 | 688.04 to 791.09 |           188.65 | 163.95 to 194.25 |
| Switch request through immediate `get_state` response |          755.43 | 689.60 to 792.31 |           189.56 | 164.60 to 195.23 |
| Sum of agent `session_start` handlers                 |          589.65 | 542.40 to 628.31 |            20.60 |    3.11 to 27.61 |
| First `agent_runs list` execution                     |           72.34 |   69.91 to 75.45 |           419.87 | 383.77 to 517.36 |
| Switch request through first list result              |          829.28 | 763.77 to 866.22 |           587.01 | 580.36 to 708.42 |

The responsiveness median decreases by 565.87 ms. The first list itself becomes slower.
Do not describe this as a 75% reduction in all delegation latency or recovery work.
The measured wait through the first list also decreases, but its improvement is smaller.
These are warm-filesystem, fresh-process observations, not cold-cache or provider benchmarks.

## Source and runtime identities

- The baseline is admission `origin/main` commit `4906e67e3a6701a753df3af112304dea2246aeb1`, including the merged lifecycle and generation-test repairs.
- The candidate has one production change. It removes the final `this.scan()` call from `AgentRuntime.attach`.
- Baseline compiled build SHA-256 is `09b93d7fea1539a8e23003be654cc3bd02064d5f0e8487c2ec35f75f02c02b86`.
- Candidate compiled build SHA-256 is `5ca86446981decd79fbb9061992687feae9c27a3685cb3ca6a567effc976839b`.
- The actual official bundled CLI SHA-256 is `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`.
- [environment.json](environment.json) records the exact SDK, source, lockfile, OS, toolchain, and build identities.
- Latest official npm Pi resolved independently to 1.4.0. Maintained fork `main` resolved independently to `c17adbc400319887c5ab34fce1ed2a59be746da4`.
- The agent that produced this change used actual configured `openai/gpt-6.1-sol` with `xhigh` thinking. The coordinator supplied a supported, owner-authenticated canonical chat-configuration receipt. [actual-model-evidence.json](actual-model-evidence.json) retains the non-secret configuration, observation time, and configuration-version digest. This is not a model self-description.

The issue author's historical samples used the old installed native selector `403a2713/2005895e` and public build `045a331e` on October 23.
Those samples do not supply the before side here.
The October 24 installed update uses a different native build and public source `4906e67`.
The matching public build digest above is source provenance, not proof that this probe ran in that installation.
No installed path, native selector, private journal, account cache, or live session was accessed.

## Measurement method

[benchmark.py](benchmark.py) creates every input from scratch and drives the actual official bundled CLI over stdin/stdout RPC.
The loaded extension wraps the compiled agent factory, not a mock runtime.
It deliberately isolates the issue's agent attach path from the observer and intercom broker.
The result is not a full-package startup measurement.

Each sample starts a fresh process with an empty private HOME, agent directory, temporary directory, and minimal environment.
The CLI is offline, telemetry is disabled, and resource discovery is disabled.
No provider credentials, model inference, child launch, or network response supplies the measured work.
After observing real initial `session_start`, the driver requests `get_state`, then starts the switch timer immediately before sending `switch_session`.
It validates the switch response, requests `get_state` again, and validates the selected session.
The next command calls the actual registered `agent_runs` tool with `action=list` and checks the full inventory count and first-page count.
This command does not simulate a model-generated tool call.
The regression test separately executes the tool through the actual SDK tool wrapper.

Two timestamp callbacks bracket native agent `session_start` dispatch.
No syscall wrappers or CPU profiler run in the comparative samples.
Official Pi 1.4.0 dispatches `session_start` twice during this RPC replacement.
The raw records retain both events, and the micro metric sums them.
The extension does not change that host behavior.

One warmup A/B pair preceded the comparisons.
Five A/B pairs first exposed the first-tool latency tradeoff.
A second set of five A/B pairs added the complete switch-to-first-tool timer.
The table uses only that complete set. Both sets, warmups, and failed setup attempts are retained.
Both sides use the same Node binary and locked dependencies. Fixtures are freshly written on the same filesystem.
Neither side drops caches or changes tuning. Samples run sequentially with no parallel tests or builds.
Admission load averages were `0.11, 0.04, 0.01` on two available CPUs.

The driver waits through an existing scan interval, checks another successful response, and requests graceful shutdown.
It checks the final attachment's `attached=false` value and process exit status.
The native regression test proves actual timer-driven chronological completion publication and duplicate suppression without a readiness sleep.

## Limiter and limits

Separate profiled CLI runs identify the eager completion scan as the baseline attach limiter.
On the first baseline attach in the final profile, the scan opens run metadata and reads the parent receipt journal.
The second dispatch reuses the warmed receipt and settled-run caches but still probes the inventory.
[profile-samples.json](profile-samples.json) contains the exact per-event syscall counts and elapsed times.
[cpu-summary.json](cpu-summary.json) maps whole-process CPU samples to the agent scan and notification frames.
The raw CPU profiles are retained in the archive. Their whole-process scope includes later timer work and startup imports.
Do not sum nested CPU rows or syscall timings.

The profile shows JSON projection/parser work and run metadata probes, not an expensive cloud `fsync`, as the removable limiter.
The candidate performs no inventory scan inside either attach callback.
Its first needed list pays for the cold physical receipt index. Later timer work still reconciles completions.
The remaining switch latency includes native journal loading, session replacement, and attachment durability.
The responsiveness reduction is smaller than the removed attach time, consistent with that remaining host work.

No throughput claim is made for a private corpus, concurrent switches, model execution, or the managed launcher's interactive UI.
The official CLI and direct SDK use process-lifetime attachment ownership.
The maintained launcher's accepted `host.ready` path already defers attachment beyond `session_start`.
This change preserves that gate. It does not claim an additional measured managed-launcher startup improvement.
The existing managed-host keeper covers provisional nonpublication, handoff generation retention, and unready quit.
Hosted CI separately qualifies the real official and fork dependency graphs and actual native package/CLI paths on the repository's platforms.

## Design and verification trail

The data shape was named before implementation. The existing attachment contains process identity, optional clock, generation, and attached state.
The completion scanner consumes launches, canonical results, and physical native receipt IDs.
No new persisted shape, promise chain, cancellation token, attachment writer, or ownership state is added.

The throughput checkpoint was a current-main profile, an actual CLI switch/readiness boundary, first-needed-tool latency, and native backlog recovery.
The smallest supported change removes the eager scan and uses the already-owned 200 ms interval.
The interval is not a hard delivery deadline. A main that exits before its first scan may leave retained completions for its next persistent owner.
An immediate prompt can start before recovery and then receive the recovered messages as steering input.
These are intentional timing tradeoffs, not changes to receipt authority or canonical ordering within a scan.

Attachment mkdir, atomic write, fsync, rename, process identity, generation, host readiness, and shutdown joining remain unchanged.
No deferred attachment write can publish after a later owner because this patch introduces none.
Explicit non-list `agent_runs` actions and `agent_settled` retain their scan paths.
`agent_runs list` is not itself a recovery trigger.

A real independent read-only delegate reviewed the timer/publication contract and found no requirement for eager recovery before `session_start` returns.
Its source-only review is not presented as a test run or as one of the hosted reviewers.
The Pi adapter's how, architect, arena, swarm, and no-comments panels were not selected because this local deletion had no unresolved architectural decision requiring them.
Standalone adapter cleanup inspected the changed code and surrounding contracts before commit. No forwarding helper, suppression, new comment, speculative state, or hidden error catch was added.

The native regression was red on baseline and green after the deletion.
See [red-agent-attachment.log](red-agent-attachment.log) and [green-agent-attachment.log](green-agent-attachment.log).
It observes actual attachment publication, first-tool inventory, native chronological completion entries with exact output, and no duplicate receipt after explicit reconciliation.
Required local checks and hosted qualification results are reported on the PR at the current head.
Full `npm run ci` remains hosted-only under repository policy.

The principles used were Model the Domain, Laziness Protocol, Sequence Work into Verifiable Units, Test Behavior Not Implementation, Explain the Number, and Prove It Works.
They changed the implementation choice toward one deletion, preserved the existing lifecycle state, required a red native boundary test, and kept cold first-tool cost beside the responsiveness result.

## Reproduce and inspect

The script takes an unused output directory, baseline checkout, candidate checkout, and selected SDK package directory.
Build both snapshots with `npm run build` first. Use the same locked dependency graph on both sides.

```sh
node --version
npm --version
uptime
nproc
npm ci --ignore-scripts
npm run build
python3 docs/evidence/issue-248/benchmark.py /workspace/attach-warmup \
  /workspace/issue-248-baseline /workspace/issue-248 \
  /workspace/issue-248/node_modules/@earendil-works/pi-coding-agent --rounds 1
python3 docs/evidence/issue-248/benchmark.py /workspace/attach-comparison \
  /workspace/issue-248-baseline /workspace/issue-248 \
  /workspace/issue-248/node_modules/@earendil-works/pi-coding-agent --rounds 5
python3 docs/evidence/issue-248/benchmark.py /workspace/attach-profile \
  /workspace/issue-248-baseline /workspace/issue-248 \
  /workspace/issue-248/node_modules/@earendil-works/pi-coding-agent --rounds 1 --profile
```

[samples.json](samples.json) contains every final unprofiled sample and work counter.
[summary.json](summary.json) contains medians and ranges.
[transcripts.tar.gz](transcripts.tar.gz) retains public-safe actual RPC transcripts, requests, generated observer modules, exact commands/environments, stderr, CPU profiles, and one complete synthetic native input journal.
All remaining generated synthetic journals and run inventories remain in the task's cloud evidence directory. They were not deleted during cleanup.

Three setup failures are retained, not counted as successful measurements.
The first used redirected `console.log` and an invalid temporary-root name.
The second found that Pi also redirects `process.stdout.write` during extension execution.
The third exposed the host's two native start dispatches and failed the initial one-dispatch assumption.
The corrected driver uses `fs.writeSync(1, ...)`, a dedicated `pi-subagents-*` temporary root, and retains every dispatch.
No production checker, assertion, timeout, identity rule, or support requirement was weakened.
