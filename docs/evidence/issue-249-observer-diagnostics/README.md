# Observer timeout: retained evidence, not an invented behavioral fix

After head1543 fixed the archive aliases and owned-TMPDIR teardown, both Linux lanes completed228 integration cases and production install qualification. The first macOS attempt instead cancelled the unchanged metadata-cache observer keeper at its30-second timeout:224 passes, one cancellation, three platform skips. Its full failed job120936485292 log is retained separately from the later successful job120938776271 log. Run40115709218 attempt2 was maintainer-triggered (`triggering_actor: fitchmultz`) and passed; this chat did not request that rerun. A passing retry does not identify the original cause.

The keeper SHA256 was identical at576587a and1543b57: `83a88a38a786462593886256a2044de7ee6b62f78b2d96af4c07048d253953f5`. The failed log has no blocked-phase receipt or available journal snapshot. No original failed-run fixture is reconstructed or substituted here.

Read-only diagnosis inspected actual observer code and the maintained fork at exact ref `c17adbc400319887c5ab34fce1ed2a59be746da4`. It refuted the proposed asynchronous two-Escape modal-transition race: one screen handles back synchronously and recomputes actions for the next input. Conditional repeated-navigation hydration cancellation remains a source-level hypothesis, **not an observed cause**; no speculative production patch was made.

## Bounded diagnostic change

Only this keeper and its keeper-only reading helper change:

- Canonical `/tmp/observer-cache-*` root is retained outside HOME/suite/CI cleanup, with an immediate exact-path diagnostic.
- Named phase receipts cover existing waits, initialization, command settlement, navigation and disposal. Wrappers directly return the existing wait promise: no additional await, polling delay or readiness condition.
- A small before-disposal snapshot captures phase history, actual screen, terminal tail and recent native send/open/scan/probe observations. Cancellation also emits it into the job log. Capture is inside cleanup-protected `try/finally`; diagnostic failures still attempt disposal and all restoration and are not swallowed.
- Every original assertion, key/mouse input, ordering,15-second wait,20ms poll and30-second case timeout is unchanged. Production source, dependencies, peers, locks and checkers are unchanged.

The local **official** SDK keeper passes with zero skips; lint, format, TypeScript and size checks pass. This does not establish local fork equivalence or repair the unexplained timeout. Same-model independent static review found no remaining actionable findings after correcting diagnostic cleanup protection. Fresh final-head hosted qualification and enabled reviews remain required.

`native-roots.tsv`, the packet and checked inventory preserve456 actual JSONL entries across two local diagnostic runs, including the pre-finally-guard authoring run. Identity-bearing originals remain under workspace. Generated auth/model/settings files, compiler caches and socket endpoints are omitted; only disposable OS device aliases were removed after processes exited. Extract the synthetic packet only into a disposable private directory. Runner-local retained paths alone do not establish durable upload or survival after runner disposal.

All prior evidence epochs remain unchanged. Archive command SHA256 remains `eb3965d4913dac7033b49ceda63f447479f05e3bad2376fe2286b4e79501c0a2`; no live history, installed runtime, account, provider, model/default setting, purge or PR merge is touched.
