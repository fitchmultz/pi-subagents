# Development

Use a dedicated worktree, the committed npm lockfile, and a ready-for-review PR.
Never edit source or tests while checks run in that checkout. Do not modify an
active installed copy or reload the user's sessions to test a candidate.

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
node scripts/measure-size.mjs
```

Run narrow owner-boundary tests locally through `scripts/run-tests.mjs`. Full
`npm run ci` belongs in hosted CI and includes package/install smokes and the
complete suites. Keep the strict Oxlint/Oxfmt rules; see [code quality](code-quality.md).

## Runtime qualification

Qualify the latest stable official Pi and the intended fork revision separately.
Record the exact package root, revision/build, Node binary, and executed test
commands. Matching versions do not establish matching runtime behavior.

Production-only installs must resolve the selected host's SDK and TypeBox, not
shadow them with this package's development graph. Exercise the packed single
entry through the real Pi loader and an actual native child session. Native faux
providers can test tools, receipts, journals, process lifecycle and output without
paid model calls; they are not live-model evidence.

Real-model acceptance additionally checks that full forked history preserves an
actual earlier delegation result, and that ordinary main/child sessions discover,
message, and read last responses across agent directories under the confirmed
two-level topology. Never publish credentials or private transcripts as evidence.

## Isolation and safety

Every test/smoke broker uses a short, explicit `PI_INTERCOM_RUNTIME_DIR` owned by
the fixture. Do not touch `/tmp/pi-intercom-<uid>` to test namespace behavior on a
workstation with active sessions. Tests for the default path inspect it without
starting or deleting the user's broker. Stop owned processes and remove temporary
resources even on failure or signal cancellation.

Preserve native receipt, cold-crash, shutdown, continuation and broker contracts
at their actual SDK, journal, filesystem or process boundary. Carry distinct
assertions into the keeper before deleting an old test. Feature retirement is not
proof that an unrelated safety assertion can disappear. Expected values must be
independent of production helpers; observe actual readiness/publication before
negative assertions. A sleep does not prove an owner processed its input.

## Size gate

`scripts/measure-size.mjs` counts source, production scripts, generated code and
schemas, including new untracked files. `--report` prints without enforcing.
The ceilings are 16,000 source TypeScript lines, 20,000 total production lines,
and 1 MiB total production bytes. Tests have no deletion quota. Moving machinery
into generated/minified output does not evade the gate.

[The rebuild evidence](single-agent-rebuild.md) records the baseline, confirmed
design, test-transfer obligations, and exact selected host identities. Update it
with measured final evidence; do not confuse planned gates with passed checks.
