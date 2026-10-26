# Empty-owner idle CPU for issue 238

## Result

The 30 ms idle ceiling from issue 238 section 3 still fails. This change does not convert it to a pass.
Most of the measured increment is not continuous pi-subagents work. It is a one-shot pair of V8 memory-reducer garbage collections. Pi's bundled loader triggers them for any extension that imports a host module.
The remaining pi-subagents cost is mostly one-shot startup work in the first second.

## Unchanged campaign

The campaign used the unmodified `profile-managed.py` (SHA-256 `e5a67e38…a73f4`) and `managed-observer.mjs` (`6911737d…ca927`), with 7 alternating startup rounds and 3 idle windows of 10 s per case and host.
It added a diagnostic `typebox` case, a two-line package containing `import "typebox"; export default function () {}`.
The profiler exited 1 on the idle ceiling for every non-floor case, including that two-line package.
Idle values are milliseconds of process CPU per 10 s after `session_start`, as medians of 3 samples.

| Host                     |  Floor | Typebox-only | Merged `0b6da9b` | Main `bb38f682` |
| ------------------------ | -----: | -----------: | ---------------: | --------------: |
| Official Pi 1.4.0        | 15.885 |       54.032 |           75.980 |          74.752 |
| Fork `ed4e110b/350c6361` | 18.792 |       59.545 |           74.056 |          74.532 |

- The increment over the floor is 38.147, 60.095 and 58.867 ms on official Pi. On the fork it is 40.753, 55.264 and 55.740 ms.
- Against the typebox-only package, `0b6da9b` adds 21.948 ms on official Pi and 14.511 ms on the fork. `bb38f682` adds 20.720 and 14.987 ms.
- That matched-loader comparison is diagnostic. It is not the acceptance verdict, which is defined against the floor.

The original `0b6da9b` acceptance run measured +63.263 ms on official Pi and +57.382 ms on the fork. It remains a failure.
[results.json](results.json) lists every sample, the startup values, and the host CLI and SDK hashes.

## Native boundary

A separate diagnostic observer recorded process CPU every 250 ms. It has no event-loop monitor, so its floor is about 4 ms instead of about 16 ms.
The runs added `--trace-gc`, `--trace-memory-reducer` and `--trace-mutator-utilization`.

1. Pi's bundled CLI loads extensions through jiti 2.7.0 with `tryNative: false` and `virtualModules` (`loadExtensionModule` in `dist/core/extensions/loader.js`).
2. A module that imports `typebox` or a `@earendil-works/pi-*` package is transformed and evaluated with `vm.runInThisContext` (jiti `dist/jiti.cjs`). Node 24 allocates the resulting script on V8's C++ heap. `v8.getCppHeapStatistics().used_size_bytes` changes from 0 to 128,968 at `session_start`. An empty package and a package with 120 relative-only modules leave it at 0.
3. V8 13.6 arms the memory reducer after the startup mark-compact. Eight seconds later it starts reducing only when the young, old and embedder allocation rates are all low (`MemoryReducer::TimerTask::RunInternal` and `Heap::HasLowAllocationRate`).
4. With no C++ heap allocation, the embedder rate is exactly zero. `ComputeMutatorUtilizationImpl` returns 0 for a zero rate, so V8 reports "high alloc" and waits again. In two 40 s floor runs it never reduced. Once any C++ heap allocation exists, the embedder utilization is 1.000 and V8 runs two `Mark-Compact (reduce)` collections at about 8.3 s and 8.9 s of uptime.

| Diagnostic case, median ms per 10 s  | Official | Fork |
| ------------------------------------ | -------: | ---: |
| Floor                                |      3.7 |  5.7 |
| Empty package                        |      3.5 |  5.2 |
| Typebox-only package                 |     42.5 | 45.8 |
| Merged `0b6da9b`                     |     60.8 | 61.6 |
| `0b6da9b` with `--no-memory-reducer` |     17.6 | 17.5 |

Each row has 3 runs, and the collection count was the same in every run of a row.
The reducer flag is a counterfactual only. It is not a remedy, and this change sets no V8 flag.
The collections spend about 42 ms of user time and 3 ms of system time, mostly on GC threads.

## Pi-subagents work

With the extension modules imported but no factory call, `0b6da9b` still ran both collections in 3 of 3 runs, with a 47.6 ms median.
The first second after `session_start` costs about 14 ms with every part enabled. Intercom accounts for about 7.7 ms by spawning and connecting its private broker. Agent attachment and its first scan account for about 4.7 ms, including about 2.2 ms for the owner's synchronous `ps` identity read. The observer adds nothing measurable.
In two 40 s official runs, each later 10 s window used 3.3 to 3.6 ms against the floor's 2.4 to 3.1 ms.
Disabling the one-second recovery probe saved about 0.6 ms per 6 s. The collections still ran in 2 of 3 of those runs.

No removable startup work was found. The owner identity needs `ps` because Node exposes no process-group query, and the private broker is required for message delivery.

## Limits

All runs used macOS arm64 under ambient load from other agents. Each case has 3 idle samples per host.
Trace and profiler runs are diagnostic and separate from the reported campaign values.
The diagnostic packages use no credentials, provider calls or child launches.
Only the diagnostic observers read the C++ heap counter or use trace flags. This package does neither.
