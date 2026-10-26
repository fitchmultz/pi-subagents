# Empty-owner idle CPU for issue 238

## Result

The 30 ms idle ceiling from issue 238 section 3 still fails. This change does not convert it to a pass, waive it, or change any runtime code.
Most of the measured increment is not continuous pi-subagents work. In the sampled configurations it is a one-shot pair of V8 memory-reducer garbage collections about 8 s after `session_start`. Runs of an isolated two-line package that only imports `typebox` showed the same pair.
The remaining pi-subagents cost is mostly one-shot work right after `session_start`.

## Unchanged campaign

The campaign used the unmodified `profile-managed.py` (SHA-256 `e5a67e38…a73f4`) and `managed-observer.mjs` (`6911737d…ca927`), with 7 alternating startup rounds and 3 idle windows of 10 s per case and host.
It added a diagnostic `typebox` case, a two-line package containing `import "typebox"; export default function () {}`.
The profiler exited 1 on the idle ceiling for every non-floor case, including that two-line package.
Idle values are milliseconds of process CPU per 10 s after `session_start`, as medians of 3 samples.

| Host                     |  Floor | Typebox-only | Merged `0b6da9b` | `bb38f682` artifact |
| ------------------------ | -----: | -----------: | ---------------: | ------------------: |
| Official Pi 1.4.0        | 15.885 |       54.032 |           75.980 |              74.752 |
| Fork `ed4e110b/350c6361` | 18.792 |       59.545 |           74.056 |              74.532 |

- The `bb38f682` column is a package packed from commit `bb38f682`, tree `bfa34d60`, build `fc084c36`. It is not a measurement of any later main.
- The increment over the floor is 38.147, 60.095 and 58.867 ms on official Pi. On the fork it is 40.753, 55.264 and 55.740 ms.
- Against the typebox-only package, `0b6da9b` adds 21.948 ms on official Pi and 14.511 ms on the fork. The `bb38f682` artifact adds 20.720 and 14.987 ms.
- That matched-loader comparison only estimates extension work beyond a comparable host-import cost. It is not the acceptance verdict, which is defined against the unloaded floor.

The original `0b6da9b` acceptance run measured +63.263 ms on official Pi and +57.382 ms on the fork. It remains a failure.
[results.json](results.json) lists every sample, the startup values, and the host CLI and SDK hashes.

## Native boundary

A separate diagnostic observer recorded cumulative process CPU every 250 ms. It has no event-loop monitor, so its floor is about 4 ms instead of about 16 ms.
Traced runs added `--trace-gc` and either `--trace-memory-reducer` or, for the counterfactual, `--no-memory-reducer`. The empty-package and typebox-only runs also added `--trace-mutator-utilization`.
The chain below describes these sampled packages, Node 24.22.1 (V8 13.6.233.17-node.58) and both hosts' bundled CLIs. It is not a rule for every extension, import, Node version or host.

1. Both bundled CLIs load extensions through their static Jiti loader with `virtualModules` and `tryNative: false`. Each resolves an installed Jiti 2.7.0 whose `dist/jiti.cjs` has SHA-256 `a0b3b8d5…acd24c49` on both hosts.
2. `tryNative: false` does not force every file through a VM script. When Jiti 2.7.0 decides a file needs no transformation, as for an ESM `.js` file loaded through an asynchronous import, it tries a native import first and transpiles only if that fails. Files that need transformation, such as TypeScript, go directly to transpilation ([`eval.ts` L38–91](https://github.com/unjs/jiti/blob/v2.7.0/src/eval.ts#L38-L91)). Either way, a transpiled module is compiled with `vm.runInThisContext` ([L141–149](https://github.com/unjs/jiti/blob/v2.7.0/src/eval.ts#L141-L149)). Whether an extension takes that path depends on its imports and on where it is installed. Bare host imports from these isolated packages can need the fallback and virtual-module resolution; relative-only ESM can load natively.
3. Node allocates each `vm` script's `ContextifyScript` on V8's C++ heap ([`vm.js` L312–317](https://github.com/nodejs/node/blob/v24.22.1/lib/vm.js#L312-L317), [`node_contextify.cc` L972–977](https://github.com/nodejs/node/blob/v24.22.1/src/node_contextify.cc#L972-L977)). In the six traced 10 s typebox-only runs, `v8.getCppHeapStatistics().used_size_bytes` read 0 when the observer loaded, 128,968 at `session_start` and 0 at the end. Short untraced official probes showed the same 128,968-byte checkpoint for packages importing the SDK, TUI, AI or TypeBox packages or the extension's own modules. Imports of `node:net`, `node:crypto` and `node:child_process`, an empty package, and a package with 120 relative-only modules all read 0. These readings are consistent with the Jiti fallback path, but the retained data do not identify the allocating call directly. The 120-module probe lasted 1.5 s and was untraced, so it shows only the zero heap reading, not an absence of later collections.
4. After the startup mark-compact, V8's memory-reducer timer waits and then re-checks the allocation rate about every 8 s ([`memory-reducer.cc` L38–71](https://github.com/nodejs/node/blob/v24.22.1/deps/v8/src/heap/memory-reducer.cc#L38-L71)). It may start reducing when the rate is low, when the heap is set to optimize for memory, or after a guarded 100 s watchdog. The start also requires that incremental marking can begin ([L155–242](https://github.com/nodejs/node/blob/v24.22.1/deps/v8/src/heap/memory-reducer.cc#L155-L242)). The allocation rate is low only when young, old and embedder utilization each exceed 0.993 ([`heap.cc` L3669–3728](https://github.com/nodejs/node/blob/v24.22.1/deps/v8/src/heap/heap.cc#L3669-L3728)). Utilization is `gc_speed / (allocation_throughput + gc_speed)`. It is 0 when allocation throughput is exactly 0, and a missing GC-speed estimate defaults to 200,000 bytes/ms.
5. In the traced runs, the empty-package traces printed embedder utilization 0.000 and "high alloc", then waited another 8 s. The typebox-only traces printed 1.000 and "low alloc, foreground", then ran two `Mark-Compact (reduce)` collections about 8.06 s and 8.67 s after `session_start` (8.25 s and 8.86 s process uptime on official Pi). This is consistent with zero embedder allocation throughput in the first case. In the second, a small nonzero throughput combined with the default GC speed would explain it. The trace rounds its fields (both print `mutator_speed=0, gc_speed=0`), so it cannot prove those internal values. A nonzero C++ heap reading by itself is not a sufficient condition.
6. In two 40 s official floor runs, every reducer check through the end reported "high alloc" and no reducing collection ran. That does not rule out a later watchdog collection. Nothing here establishes a V8 bug.

| Diagnostic case, median ms by about 9.8 s | Official | Fork |
| ----------------------------------------- | -------: | ---: |
| Floor                                     |      3.7 |  5.7 |
| Empty package                             |      3.5 |  5.2 |
| Typebox-only package                      |     42.5 | 45.8 |
| Merged `0b6da9b`                          |     60.8 | 61.6 |
| `0b6da9b` with `--no-memory-reducer`      |     17.6 | 17.5 |

Each row has 3 traced runs, and the reducing-collection count was the same in every run of a row (0, 0, 2, 2 and 0).
The reducer flag is a counterfactual only. It is not a remedy, and this change sets no V8 flag.
Between the samples at about 6.8 s and 9.8 s, the whole-process counters of the six `0b6da9b` runs rose by 41.0 to 45.0 ms of user time and 2.4 to 3.2 ms of system time. Floor and `--no-memory-reducer` runs rose by at most 0.93 ms and 0.31 ms over the same interval. The observer cannot separate threads or attribute CPU to GC directly. The GC attribution is an inference from the trace timing and the disabled-reducer counterfactual.

## Pi-subagents work

With the extension modules imported but no factory call, `0b6da9b` still ran both collections in 3 of 3 traced runs, with a 47.6 ms median. Imported modules can do work as they evaluate, so this is not a zero-work baseline.
With every part enabled, the first sample interval after `session_start`, which ends at about 0.75 s, costs about 14 ms.
Comparing 3-run variants that disable one part at a time suggests that:

- intercom's private broker spawn and connection account for about 7.7 ms;
- agent attachment and its first scan account for about 4.7 ms;
- the owner's synchronous `ps` identity read accounts for about 2.2 ms within that;
- the observer adds nothing measurable.

These are differences between medians of separate run groups, not measured function self-times, and they need not add up.
Disabling the one-second recovery probe lowered CPU between the samples near 0.75 s and 6.8 s by about 0.6 ms. The collections still ran in 2 of those 3 runs.
Two sequential official-host floor/`0b6da9b` pairs ran for 40 s each. Their later windows end at samples near 19.8, 29.9 and 39.9 s, so each is about 10 s long. The candidate used 3.3 to 3.6 ms per window against the paired floor's 2.4 to 3.1 ms, a difference of 0.25 to 1.10 ms. There is no fork long run, and this is not an indefinite-idle bound.

No removable startup work was found. The owner identity needs `ps` because Node exposes no process-group query, and the private broker is required for message delivery.

## Method and provenance limits

- Diagnostic timeline values use the last sample at or before each bound. The "10 s" values end at 9.775 to 9.991 s, and the "first second" values end at 0.751 to 0.841 s. [results.json](results.json) records each endpoint.
- GC times in traces are process uptime. Where recorded, the observer's `session_start` uptime converts them to session-relative times.
- The diagnostic observer changed during the investigation. Earlier timelines record total CPU only, and later ones add the user/system split, process uptime and C++ heap readings. No exact copy of each earlier observer revision was kept.
- All runs used `--no-session` and private temporary homes, with no credentials, provider calls or child launches.
- The driver recorded each run's command and environment, but not hashes of the code each run loaded.
- The diagnostic working directory and the campaign's temporary output directory were deleted after recursive comparisons found each byte-identical to its retained copy. The copies therefore reflect each directory's final state. An independent reviewer could not recheck the original diagnostic directory.
- Neither directory contained session journal files or sockets when it was deleted.
- All runs used macOS arm64 under ambient load from other agents. Each case has 3 idle samples per host.
- Trace and profiler runs are diagnostic and separate from the reported campaign values. The one CPU-profile run was heavily perturbed, and only its sampled stack locations were used.
- Only the diagnostic observers read the C++ heap counter or use trace flags. This package does neither.
