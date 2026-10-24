# Issue 249 evidence

## Verdict and scope

This is a documentation and safety-regression change, not automatic cleanup.
The fresh current-main and candidate CLI runs both leave the retired directory
untouched. Automatically reclaimed file bytes are **0 → 0**. A manual
same-filesystem archive preserves all file allocations and frees none of them.
Archive-container metadata and verification copies can consume additional space.
There is no measured or predicted latency improvement.

The [maintenance guide](../../retired-history-maintenance.md) supplies an explicit
operator route. It does not ship an online cleanup tool or pretend to prove that
an installation is offline. Deletion, live inspection, activation, and restarts
are outside this PR.

The issue's 2.6 GB and 440 files are reported observations, not this task's
measurements. The author's historical samples used native `403a2713/2005895e`
and public `dist045a331e`, before the 2026-10-24T13:07:48Z switch. No result here
claims to measure either installed macOS distribution or the owner's corpus.

## Admission and source identity

- Pstack policy is pinned to `94f83d6fb0581e0602e467f7fafdfd9f87c4b402`.
  The Pi adapter was read first. Perf issue and Opening a PR were selected.
  Babysit drive is explicitly assigned and stops before merge.
- Current `origin/main` resolved at admission to
  `4906e67e3a6701a753df3af112304dea2246aeb1`, tree
  `54dab296b81e3aaeb02cc4b8fbc3cd29b41239d5`.
- The candidate is isolated in `/workspace/issue-249` on
  `perf/issue-249-pi-subagents`. The baseline is a detached worktree at
  `/workspace/issue-249-baseline`. Neither is an installed host checkout.
- [Actual execution configuration](actual-model-evidence.json) is
  `openai/gpt-6.1-sol` with `xhigh` thinking. The coordinator supplied supported,
  owner-authenticated canonical chat metadata. The guest cannot independently
  query that metadata. No account or setting changed.
- Production `src/` and `package-lock.json` are unchanged. The source-file SHA-256
  aggregate from `git ls-files src | sort | xargs sha256sum | sha256sum` is
  `bff9d45f12e33c0bb62647ef238a8d19e6a30eaa40eb458bde02633fd051b9b9`.
- The only package-manifest change includes the guide in published package files.
  No dependency, support floor, optional peer, or lock policy changes.

## Decision trail

The data shape was named before implementation. The recovery set consists of
owner manifests, generation databases, ingest-lock databases, timing data, and
SQLite companions. Journals are outside it. Unknown names are not ownership proof.

The throughput checkpoint was to establish historical reachability before choosing
any cleanup, then verify synthetic work and recovery at the filesystem and actual
CLI boundaries. It was not a target latency or fabricated reclaim estimate.

1. Source inspection found no current history-index owner, but a runnable old
   0.48.0 history worker and detached timing writer. A newer bridge is not an
   exclusivity barrier. An independent read-only delegate checked these facts.
2. Automatic deletion, a new advisory lock, and an `--offline` boolean were
   rejected because old releases do not participate. The smallest safe route is
   an externally isolated manual archive. The Laziness Protocol shaped that choice.
3. The archive is one recovery set. Make Operations Idempotent shaped the explicit
   source/destination reconciliation states instead of a cleanup success marker.
4. Test Behavior, Not Implementation shaped a real CLI startup assertion that
   compares filesystem bytes and identities. A deletion mutant makes that keeper
   fail. Native SQLite crash and active-handle experiments test mechanics separately.
5. No how, architect, arena, swarm, or no-comments panel was selected. This change
   has no unresolved algorithm or production architecture choice. The Pi adapter's
   standalone cleanup replaces speculative automatic panels.

A same-model independent delegate is genuine coverage, not a diverse-model panel.
No cross-model trail review is claimed. The task-owned concise checklist and native
command receipts are retained outside the repository.

## Matched uninstrumented runs

Both sides used the same cloud Debian Linux x64 workspace, Node `v24.22.1`, npm
`11.19.1`, the committed lockfile, and official Pi `1.4.0`. The baseline worktree
uses a symlink to the candidate's identical installed dependency graph. See
[toolchain hashes](toolchain.sha256) and [Node versions](node.json).
Admission load was `0.02, 0.01, 0.00` on two available CPUs.

The official registry resolved Pi to `1.4.0`, integrity
`sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==`.
The separately queried maintained fork main resolved to
`c17adbc400319887c5ab34fce1ed2a59be746da4`. Hosted qualification independently
resolves the host graph and is the authoritative full-platform result.
These observations are not a local fork qualification claim.

Exact preparation and alternating run commands were:

```sh
git clone --no-checkout https://github.com/fitchmultz/pi-subagents.git /workspace/pi-subagents-source
cd /workspace/pi-subagents-source
git fetch origin main
git rev-parse origin/main
git worktree add -b perf/issue-249-pi-subagents /workspace/issue-249 origin/main
cd /workspace/issue-249
npm ci --ignore-scripts --no-audit --no-fund
# After the test was added, the baseline worktree retained the admitted revision.
git -C /workspace/pi-subagents-source worktree add --detach /workspace/issue-249-baseline 4906e67e3a6701a753df3af112304dea2246aeb1
ln -s /workspace/issue-249/node_modules /workspace/issue-249-baseline/node_modules
for sample in 1 2 3 4 5; do
  for side in main candidate; do
    if [ "$side" = main ]; then
      entry=/workspace/issue-249-baseline/src/index.ts
    else
      entry=/workspace/issue-249/src/index.ts
    fi
    PI_RETIRED_HISTORY_EXTENSION="$entry" \
      PI_RETIRED_HISTORY_EVIDENCE_DIR="/workspace/issue-249-evidence/bin-$side-$sample" \
      node --test test/integration/retired-history-maintenance.test.ts \
      > "/workspace/issue-249-evidence/bin-$side-$sample.log" 2>&1 || exit
  done
done
```

[Raw runs and aggregates](results.json) retain the five alternating A/B samples.
Each side passed all four cases in all five runs. The real selected-host CLI loads
all three package tools and shuts down without a model request. It preserves all
16 retired-directory members, including an open SQLite writer, unknown content,
and symbolic and hard links to a synthetic outside journal. Removed members and
errors are zero. This is the end-to-end upgrade/startup boundary, not a mock CLI.

The separate cold-archive experiment uses three valid synthetic SQLite databases,
a manifest, and WAL/SHM companions. The tables contain synthetic fixture values,
not copied historical schemas or private data. Each writer acknowledges readiness
before SIGKILL. Each recovery uses a full working copy and native SQLite.

- Uncommitted case, five samples per side. Ten files, logical size median
  147,822 bytes, range 147,822 to 147,822. File allocation median 163,840 bytes, range
  163,840 to 163,840. The archive preserves both counts. Three databases recover only
  the committed row.
- Committed case, five samples per side. Ten files, logical size median
  160,182 bytes, range 160,182 to 160,182. File allocation median 176,128 bytes, range
  176,128 to 176,128. The archive preserves both counts. Three databases recover both
  committed rows.
- The active-handle experiment demonstrates a write after rename and recreation of
  the old path. Both locations then exist. This is evidence against online cleanup,
  not a claim that the tests can certify operator quiescence.

The test runner's elapsed durations remain in the raw logs. They include fixture
setup, subprocess startup, hashing, assertions, and copies. They are not benchmark
timed regions and are not used for a performance comparison. Cache tuning is
identical on both sides. No microbenchmark or user-latency claim is made.

## Separate filesystem profile

```sh
PI_RETIRED_HISTORY_EVIDENCE_DIR=/workspace/issue-249-evidence/bin-profile \
  strace -f -e trace=%file -o /workspace/issue-249-evidence/bin-filesystem.trace \
  node --test --test-name-pattern='actual selected-host CLI' \
  test/integration/retired-history-maintenance.test.ts
```

[Profile summary](profile-summary.txt), [profile run](profile.log), and the
[complete compressed trace](filesystem.trace.gz) are separate from the samples.
The test owner and synthetic crash writer access the old directory. The actual CLI,
its broker, and their remaining threads do not. The limiter is missing lifecycle
work combined with old-process reachability, not CPU throughput. The active-handle
experiment demonstrates why a namespace operation cannot remove that limitation.
No traced elapsed time is reported as a performance result.

## Negative control, failures, and limits

The [negative-control log](negative-control.log) retains the expected exit 1.
A temporary, uncommitted extension wrapped this candidate and removed only its
synthetic `PI_CODING_AGENT_DIR/history-index` at `session_start`. The actual CLI
loaded it. The filesystem keeper then failed with `ENOENT`, proving it detects the
unsafe automatic deletion. The wrapper is not part of the PR or a maintenance tool.
The equivalent repeat command is:

```sh
PI_RETIRED_HISTORY_EXTENSION=/workspace/issue-249-evidence/negative-control.ts \
  PI_RETIRED_HISTORY_EVIDENCE_DIR=/workspace/issue-249-evidence/bin-negative-control \
  node --test --test-name-pattern='actual selected-host CLI' \
  test/integration/retired-history-maintenance.test.ts
```

The [first lint attempt](lint-initial.log) also exited 1. It caught `.sort()` on a
readonly assertion-helper result. The test now uses `toSorted` with a comparator.
No checker was relaxed. All failed attempt logs and temporary synthetic recovery
sets remain retained in `/workspace/issue-249-evidence`.

The tests verify preservation, SQLite crash recovery, interruption states before
and after rename, and the both-present relaunch hazard. They do not implement or
automatically enforce the runbook's ownership, permission, unknown-file, foreign-UID,
quiescence, destination-collision, or power-loss prerequisites. Those are mandatory
operator stop conditions, not claimed passing automated checks. No foreign-UID
mutation, real installation, private corpus, live-model call, macOS local run, or
live purge was performed. The CLI exits at session startup, so it creates no model
conversation journal. Its empty stdout JSONL and stderr files, synthetic journal
sentinels, and database recovery sets are retained with the local evidence.

Local commands `npm run lint`, `npm run format:check`, `npm run typecheck`,
`npm run check:size`, `npm run build`, and `npm run smoke:package` all exited 0.
Their raw `*-final.log` files are retained here. The package smoke qualifies both
runtime-only npm and standalone installs with real native actor tool execution,
published completion, and the manifest-selected bundled CLI. It also asserts that
the maintenance guide is in the packed artifact.

The initial fixture used the SDK's unbundled `dist/cli.js`. It was corrected to
resolve `bin.pi` from the selected host manifest. All linked A/B runs and the
profile were then repeated against the actual bundled package CLI. Earlier runs
remain retained locally. No source implementation or dependency changed.

The separate original-0.48.0 reader/writer probe below also exited 0. It proves
that the original `recordRun` recreates the old directory after an archive and that
`loadRunsForAgent` reads the new sample. The retained archive has the distinct old
sample, checked through a complete working copy. This is actual historical source
execution on synthetic paths, not a launch of an installed bridge or old full CLI.
See [the raw probe result](legacy-relaunch.log).

```sh
git -C /workspace/pi-subagents-source worktree add --detach /workspace/issue-249-legacy v0.48.0
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = mkdtempSync('/workspace/issue-249-evidence/legacy-relaunch-');
const agent = join(root, 'agent');
mkdirSync(agent);
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = agent;
const { recordRun, loadRunsForAgent } = await import('/workspace/issue-249-legacy/src/runs/shared/run-history.ts');
recordRun('synthetic-agent', 'before archive', 0, 1);
const source = join(agent, 'history-index');
assert.ok(existsSync(join(source, 'run-timing.sqlite')));
assert.equal(loadRunsForAgent('synthetic-agent')[0]?.task, 'before archive');
const archive = join(root, 'archive');
renameSync(source, archive);
recordRun('synthetic-agent', 'after archive', 0, 2);
assert.equal(loadRunsForAgent('synthetic-agent')[0]?.task, 'after archive');
const working = join(root, 'working');
cpSync(archive, working, { recursive: true });
const recovered = new DatabaseSync(join(working, 'run-timing.sqlite'));
assert.equal(recovered.prepare('SELECT task FROM samples').get()?.task, 'before archive');
recovered.close();
console.log(JSON.stringify({ legacySource: 'd4caa1351c6dbc181276860123b5b00c969de56b', node: process.version, sqlite: process.versions.sqlite, root, originalRecreated: existsSync(source), archiveRetained: existsSync(archive), sourceMembers: readdirSync(source), archiveMembers: readdirSync(archive), expectedDistinctSamples: 2, errors: 0 }));
JS
```

The pinned watch-pr implementation depends on Bun and an authenticated local `gh`
reader. Neither is exposed here. The supported cloud-native GitHub integration is
used instead for PR delivery and complete exact-head checks, reviews, comments,
threads, jobs, and logs. No local credential profile is invented, no GitHub MCP
fallback is used, and no watcher `READY` receipt is fabricated.

Full `npm run ci` belongs in hosted CI. Its official Linux, fork Linux, fork macOS,
SDK, CLI, lock, package, and production-install evidence must be read at the final
PR head before calling the PR ready. No local full-CI pass is implied here.
