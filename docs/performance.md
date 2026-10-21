# Performance and usage

## Rebuild measurements

The baseline and enforced size ceilings are in
[the rebuild evidence](single-agent-rebuild.md). `node scripts/measure-size.mjs`
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

| Explicit extensions                      | Individual wall-clock times (ms) | Minimum (ms) | Range (ms)    |
| ---------------------------------------- | -------------------------------- | -----------: | ------------- |
| None (host floor)                        | 220.30, 222.89, 225.32           |       220.30 | 220.30–225.32 |
| Baseline `1646ab89`, two package entries | 980.63, 462.70, 464.58           |       462.70 | 462.70–980.63 |
| Replacement, single package entry        | 440.30, 373.10, 374.75           |       373.10 | 373.10–440.30 |

These measure extension factory loading, not interactive startup, completion
latency, or steady-state memory. The minimum decreased, but the delta is smaller
than the baseline's observed first-run spread: this small sample is not a general
speedup claim. The long-lived costs remain explicit: a main reconciles receipts
on a 200 ms timer, native actors poll their durable command/attachment state, and
the broker maintains connections/presence. Completed actors stay messageable
while attached; observed owner detachment ends their lifetime. Native lifecycle
and live acceptance checks verify disposal/exit, rather than inferring cleanup
from a timer or package size.

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
- Owner recovery must verify journal publication and process identity. Stat-only
  caches, elapsed time, and mere queue admission cannot replace those checks.
- Paged output bounds each response, not all storage or history work. Keep the
  returned cursor/offset when reading large responses rather than assuming a
  preview is the full result.

## Accounting

Native child journals are the underlying execution record. Parent attribution
must use finalized native tool-result usage receipts, excluding inherited launch
baseline entries and already attributed child contributions. Read-only inspection
and custom completion notifications are not finalized nested-model charges.
Preparing or discarding a result must not reserve usage as if it were published.

Do not sum a parent's attributed child usage and the same child's journal as two
independent provider requests. An incomplete accounting record does not erase a
real completed answer or authorize fabricated usage. Preserve optional reasoning
and cache fields according to native Pi semantics rather than adding them twice.

For an actual usage spike, compare provider records for the relevant time/model
with native parent/child execution, launch counts and fresh/fork choices. Token
counts alone do not establish dollar cost, duplicate billing, or a spawn loop.
Keep credentials and private journals out of public issues and PR evidence.
