# Performance and usage

## Rebuild measurements

The baseline is in [the rebuild evidence](single-agent-rebuild.md); the only
enforced ceiling is the 1 MiB total production bytes. `node scripts/measure-size.mjs`
measures production source, schemas, generated code and scripts; tests are separate.
Line/byte reductions are not measurements of latency, resident memory, provider
cost, or throughput.

Earlier release performance tables described the retired profile/workflow/SQLite
browse/UI engine. They remain in Git history, not current runtime claims. Final
startup A/B evidence must identify both extension snapshots, exact host, Node,
isolation settings, repetitions, and observed range. Do not infer a speedup from
smaller source or a single warm launch.

### Observed isolated factory startup

Three sequential runs per case used the physical Node 24.22.0 executable and the
fork's pinned Pi 1.3.0 CLI (`997a2575e0dde7c6690024184feec970d395f9b4`, build
`127d6b7a5b2492a2`) on macOS arm64. Each case had an empty private HOME/agent
folder, a private intercom namespace, a minimal environment, discovery disabled,
and `--list-models zzznomatch --offline -ne`. Only the named compiled entry/entries
were added with `-e`; no credentials, model turns, or installed-runtime changes.

| Explicit extensions                          | Individual wall-clock times (ms) | Minimum (ms) | Range (ms)    |
| -------------------------------------------- | -------------------------------- | -----------: | ------------- |
| None (host floor)                            | 220.30, 222.89, 225.32           |       220.30 | 220.30–225.32 |
| Baseline `1646ab89`, two package entries     | 980.63, 462.70, 464.58           |       462.70 | 462.70–980.63 |
| Replacement `1d74a79e`, single package entry | 440.30, 373.10, 374.75           |       373.10 | 373.10–440.30 |

These measure extension factory loading, not interactive startup, completion
latency, or steady-state memory. The minimum decreased, but the delta is smaller
than the baseline's observed first-run spread: this small sample is not a general
speedup claim. The long-lived costs remain explicit: a main reconciles receipts
when watched completion inputs change and stats those inputs each second, native
actors check their parent each second and scan durable commands on change, and the
broker maintains connections/presence. Completed actors stay messageable
while attached; observed owner detachment ends their lifetime. On the fork, when native
working-session capture and broker parking support are both available, a child
idle for five minutes parks its exact working state and exits, releasing its
process and heap. On official Pi, or with an older broker that lacks parking
support, idle children stay resident. A genuine message or continuation restores that exact
state at the cost of one cold actor start. No retained measurement quantifies
the memory released or the wake latency. Native lifecycle
and live acceptance checks verify disposal/exit, rather than inferring cleanup
from a timer or package size.

### Review-follow-up startup

After adding the read-only observer, the same kind of isolated factory probe
compared baseline `224e8460` with the follow-up source in this change. Each host
used three sequential repetitions, rotating floor/baseline/candidate order,
physical Node 24.22.0, private empty HOME/agent/runtime directories, offline model
listing, and disabled extension/resource discovery. No inference or credentials
were used. The hosts were official Pi 1.3.0 and fork revision `997a2575`, build
`c6a6d3874c660860`, on macOS arm64.

| Host     | Case                | Individual wall-clock times (ms) |
| -------- | ------------------- | -------------------------------- |
| Official | No extension        | 158.51, 181.78, 171.12           |
| Official | Baseline `224e8460` | 403.98, 446.65, 395.78           |
| Official | Follow-up           | 430.85, 448.78, 398.68           |
| Fork     | No extension        | 263.24, 272.81, 256.50           |
| Fork     | Baseline `224e8460` | 517.76, 496.81, 434.64           |
| Fork     | Follow-up           | 470.32, 483.65, 446.55           |

An initial probe exposed extra eager SDK/TUI loading from the screen module.
The final version loads that module only when a human opens `/agents`, then
revalidates the current session owner. These small samples overlap the baseline
ranges and do not establish a generalized speedup or latency guarantee.

Interactive mains scan at most 50 unfinished or newly discovered metadata rows
per second. Immutable launches and finished rows are cached; finished history
does not consume the active refresh budget. Liveness is checked once per active
conversation per scan, not for completed idle actors. The open watch polls at
250 ms, reading at most 64 KiB plus a 4 KiB identity header and retaining 80 bounded
display lines. Those are display limits, not truncation of the native journal.
Children and print/RPC sessions do not install the watcher.

### TypeBox host-instance startup (#234)

In runtime-only installs without a resolvable package-local or ancestor TypeBox,
the extension now uses Pi's aliased/virtual `typebox` and `typebox/value` modules
in the host. Only detached runners resolve absolute imports from the selected
host package. The Type/Assert export contracts are unchanged; there is no
package-local runtime TypeBox dependency.

An isolated Linux x86_64 RPC probe compared `ae4c363713a6c4b75092b5f15927957e915cf050`
with the same tree plus the conditional imports in `src/agent/typebox.ts`. Both
full package copies contained compiled `dist` and only the production stream
dependencies, with no TypeBox/Pi in their own `node_modules` or ancestors. The
host was the lockfile's official npm Pi 1.4.0, bundled `dist/bundle/cli.js` SHA-256
`e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`, using
`/usr/local/bin/node` v24.22.0. This is not a measurement of the maintained fork.

Each fresh process had a private empty HOME/agent/runtime directory, offline
mode, telemetry disabled, resource discovery disabled, and `PI_TIMING=1`.
The CLI arguments were `--mode rpc --no-session -ne -ns -np -nc --no-themes
--approve --offline --tools delegate,agent_runs,intercom -e <package>/dist/index.js
-e <observer.mjs>`. The observer recorded the active tools and shut down at
`session_start`; the harness asserted all three tools were registered. No
subagent or model request was launched. After warming each
snapshot once, seven A/B rounds alternated execution order (B/A, A/B, ...).

| Metric (median; observed range)            | Before                 | After                  |
| ------------------------------------------ | ---------------------- | ---------------------- |
| `dist/index.js` module import, `PI_TIMING` | 241 ms (227–267)       | 86 ms (76–102)         |
| Whole-process wall clock                   | 730.75 ms (617–754)    | 571.10 ms (546–595)    |
| Whole-process user + system CPU            | 803.89 ms (771–834)    | 610.57 ms (581–627)    |
| Peak RSS (`wait4`, MiB)                    | 141.87 (137.50–146.20) | 127.63 (120.89–129.46) |

Individual import times were before `239, 236, 251, 227, 267, 241, 259` ms and
after `78, 87, 76, 87, 81, 102, 86` ms. The median import dropped 155 ms (64%);
these are local warm-cache startup observations, not cold-cache, interactive,
model-latency, or universal performance guarantees. The package smoke separately
checks host Type/Assert identity through Pi's loader, detached Type/Assert
identity against the selected host in a production-only install, and actual
native child execution. The bundled-host identity check rejects the pre-fix
adapter. Native-loaded development or consumer graphs with independently
installed or hoisted TypeBox can resolve that copy before Jiti applies aliases;
this change does not force aliasing in those layouts. Their parent-side adapter
can now use that copy instead of the host's on-disk copy. Those graphs are outside
this production-only measurement; the full checkout functional smoke still runs.

### Session attach inventory (#248)

Session attachment no longer scans retained completions before returning. It still
publishes the same durable process identity and generation before ordinary SDK or
RPC startup completes. A one-shot recovery scan and explicit reconciliation
paths perform recovery afterward. Managed launcher attachment remains gated on
accepted host readiness.

An isolated official Pi 1.4.0 CLI probe on Linux compared current-main source
`4906e67` with this change. Five alternating pairs switched into a synthetic
42.6 MB, 5,180-entry journal with 1,000 completed runs. The median wait from the
switch request through an immediate successful `get_state` response changed from
755.43 ms to 189.56 ms. The first `agent_runs list` itself became slower because
it now pays for cold receipt indexing. This is a change to when recovery work
runs, not an installed macOS or general delegation-latency claim.

The [issue 248 evidence](evidence/issue-248/README.md) includes both waits,
switch-to-first-tool measurements, ranges, profiler results, exact runtime and
build identities, reproducible commands, and retained synthetic RPC transcripts.

### Empty-owner idle CPU (#238)

The issue 238 idle ceiling of 30 ms CPU per 10 s still fails against the
observer-only floor on official Pi 1.4.0 and the maintained fork. No runtime
change or waiver is claimed. In the sampled configurations, most of the
increment is a one-shot pair of V8 memory-reducer collections about 8 s after
`session_start`. An isolated package that only imports `typebox` showed a
128,968-byte C++ heap reading at `session_start`, followed by the same pair of
collections. That is consistent with Pi's bundled Jiti 2.7.0 loader compiling it
through `vm.runInThisContext`, which allocates on the C++ heap. Jiti
can try a native ESM import first when no transformation is needed, so this is
not a rule for every extension or host import. That two-line package added
38–41 ms in the same campaign. Against it,
the measured `bb38f682` artifact (build `fc084c36`) added 20.7 ms on official
Pi and 15.0 ms on the fork. Most of that difference is one-shot work right
after `session_start`, chiefly the intercom broker and owner attachment. In two
official-host 40 s floor/`0b6da9b` pairs, the later windows of about 10 s each
stayed within 1.1 ms of the paired floor. There is no fork long run, and this
is not an indefinite-idle bound. The
[issue 238 evidence](evidence/issue-238-idle/README.md) has the samples, host
hashes, native causal chain and limits.

## Necessary costs

- Native Pi owns context loading and model execution. The extension cannot remove
  host or provider cost by changing a status renderer.
- Fresh context is default. Applicable project resources and native tool/system
  instructions still contribute input.
- Explicit fork copies a native conversation, not a summary. Prior tool results
  remain available. Copying them preserves evidence but does not make subsequent
  provider input free or guarantee cache reuse.
- Each child runs an independent native SDK conversation. Async work can overlap
  with the parent's inference; there is no implicit daily spend limit.
- Completed answers and inbound messages can enlarge later prompts. Passive
  messages and out-of-band `last` reads do not request model inference.
- Owner recovery must verify journal publication and process identity. Elapsed
  time and mere queue admission cannot replace those checks. Completion-receipt
  and child-usage indexes parse physical LF-published bytes. For native v3
  journals, same-inode growth follows the native append-only writer contract and
  reads from the previous LF boundary; it does not revalidate old bytes. An outside
  edit to old bytes followed by an append on the same inode between observations
  is outside that contract. Changed-stamp same-size edits, shrink, inode replacement,
  and legacy/unclassified headers rebuild the index. Failed scans discard cached
  state. Native load-time migration is covered separately: official Pi 1.4.0
  rewrites in place, whereas fork core `7bc005fa` replaces the inode atomically.
- Paged output bounds each response, not all storage or history work. Keep the
  returned cursor/offset when reading large responses rather than assuming a
  preview is the full result.

## Accounting

Native child journals are the underlying execution record. Each child result
records its direct native contributions once, excluding inherited launch baseline
entries and contributions already recorded by a predecessor. New calls do not
attribute child usage to the parent: completion notices, inspection and reload
are observations, not nested-model charges.

Historical parent journals can retain child usage forwarded by the retired
foreground and `wait` collectors. When calculating workflow spend, count shared
continuation journals once and exclude child contributions already included in
historical parent tool results. An incomplete accounting record does not erase a
real completed answer or authorize fabricated usage. Preserve optional reasoning
and cache fields according to native Pi semantics rather than adding them twice.

For an actual usage spike, compare provider records for the relevant time/model
with native parent/child execution, launch counts and fresh/fork choices. Token
counts alone do not establish dollar cost, duplicate billing, or a spawn loop.
Keep credentials and private journals out of public issues and PR evidence.
