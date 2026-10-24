# Local verification before PR creation

Every command below exited 0 unless stated otherwise. Full hosted qualification is recorded on the PR at its current head.

| Command                                                                                                                              | Result                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --ignore-scripts`                                                                                                            | Installed the committed development graph.                                                                                                         |
| `npm run build` in each isolated snapshot                                                                                            | Compiled baseline and candidate. Exact build digests are in environment.json.                                                                      |
| `node --test test/integration/agent-attachment.test.ts` on baseline plus the new test                                                | Expected red, exit 1. Native startup performed one inventory scan. Retained red log.                                                               |
| `node --test test/integration/agent-attachment.test.ts test/unit/agent-managed-host.test.ts` after the deletion                      | Three tests passed.                                                                                                                                |
| `npm run lint`                                                                                                                       | Zero warnings and zero errors.                                                                                                                     |
| `npm run format:check`                                                                                                               | Passed.                                                                                                                                            |
| `npm run typecheck`                                                                                                                  | Passed.                                                                                                                                            |
| `npm run check:size`                                                                                                                 | 17,799 source lines, 20,715 production lines, 688,984 production bytes. Existing ceilings unchanged.                                               |
| `node --test test/integration/agent-attachment.test.ts test/unit/agent-managed-host.test.ts test/integration/agent-receipts.test.ts` | 26 tests passed. Native physical receipts, pending accounting, legacy safety, attachment and readiness keepers included.                           |
| Focused native lifecycle command below                                                                                               | Six selected actual native lifecycle tests passed. Unselected tests were NOT RUN in this local command.                                            |
| `npm run smoke:package`                                                                                                              | Passed production-only and standalone package loading, actual bundled CLI, native actor prompt/tool/completion, and zero paid/network model calls. |
| `npm run smoke:install`                                                                                                              | Passed package listing in temporary isolated install. No live runtime installation.                                                                |
| Five alternating CLI A/B pairs, followed by a separate profile pair                                                                  | All final assertions passed. Raw data and transcripts retained.                                                                                    |
| `git diff --check`                                                                                                                   | Passed.                                                                                                                                            |

Full `npm run ci` was NOT RUN locally under AGENTS.md. The repository's hosted workflow owns full official and fork Linux qualification and fork macOS qualification.
Managed-launcher interactive latency and the owner's installed macOS runtime were NOT RUN or measured here.
No generated contract, dependency manifest, lockfile, peer support floor, or schema changed.

Latest official Pi independently resolved to 1.4.0, matching the committed official cohort.
Its release notes and public session runtime/extension event APIs were inspected.
The maintained fork independently resolved to `c17adbc400319887c5ab34fce1ed2a59be746da4`.
Hosted CI must independently record the fork's coherent packaged graph and actual native CLI identities.

`npm audit --json` exited 1 for the existing locked graph. It reports one moderate coding-agent advisory and one high transitive undici advisory.
This change does not introduce or upgrade those dependencies. Dependency/security maintenance remains outside this one-issue performance patch.
No audit fix, checker change, timeout increase, suppression, or support relaxation was used.

Standalone cleanup reviewed all changed code and surrounding contracts before commit.
The production diff deletes one call. The regression uses existing test helpers and real SDK dispatch.
The public evidence includes only generated synthetic input and cloud tool/runtime identities.
The coordinator-supplied canonical model receipt confirms `openai/gpt-6.1-sol` and `xhigh`, with no configuration change.

The exact focused lifecycle command was:

```sh
node --test --test-name-pattern='^single-agent native (continuation|cancellation|dispose|generation|inventory)$|actual native runtime shutdown' test/integration/single-agent-runtime.test.ts
```
