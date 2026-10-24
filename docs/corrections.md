# Repeated corrections

These changes remove copyable alternate paths before adding instructions.
Occurrences below count distinct faults, not a review and its reply twice.
The native keepers run through the same Node test runner locally and in hosted
`npm run ci`; local selections leave the full suites to CI.

## Saved details accidentally become model-facing replies

Two historical faults:

- [PR #210](https://github.com/fitchmultz/pi-subagents/pull/210), reviewed at
  `224e8460891df88356d469284b7a1fc40fc82cf9`: inventory called the full run
  projection for each of 50 rows, embedding about 1.68 MB of output previews.
- [PR #242](https://github.com/fitchmultz/pi-subagents/pull/242),
  `0211ed169dee2357de60bbd2ad17fbd048adc582`: the generic reply serializer sent
  every native per-turn contribution back to the parent model, producing
  20,000-character Stop receipts.

**Level: architecture, with typed entry points and native behavior checks.**
`src/agent/view.ts` now exposes only receipt, inventory and inspection renderers.
The raw projection, summary builder and generic reply constructor are private.
The caller supplies a typed receipt, not an arbitrary object to serialize.
Inventory owns pagination and metadata-only rows. Receipt results select known
execution/accounting-status fields rather than copying the stored result and
subtracting one currently known large field. Full details and canonical bytes
remain available.

There is no higher level than removing the alternate path. Types alone cannot
bound serialized bytes or establish which persisted diagnostics belong in model
context. The existing native inventory and child-usage keepers protect those
observable obligations. The latter now also supplies an unknown nested saved
diagnostic and uses independent expected result fields, rather than deriving its
expected text from the reply being tested.

### Rejection evidence

The updated native child-usage keeper was run against the actual pre-#242 tree
`7d588e4634028e4095a787ba9df66f11f1a7ed10`, with the current test fixtures copied
in. It failed specifically at the receipt metadata assertion: all 35 native
contributions and the additional saved diagnostic appeared in model text.
The candidate passed the same keeper with both a live and an exited actor.

The inventory fault was replayed by putting the actual #210
`slice(...).map(launch => projection(...))` expression into the candidate's
inventory owner, adapting only its local variable names. The unchanged native
inventory assertions rejected its 1,720,558-byte response. Restoring the summary
path passed. This was a replay of that historical expression on the current
fixture, not execution of the entire old PR.

The original raw-view imports (`toolResult`, `projection`, `summaries`) were also
compiled against the new boundary in a disposable fixture. `npm run typecheck`
rejected all three with TS2459, because they are no longer exported.

```sh
npm run build
node --test --test-name-pattern='single-agent native (child usage|inventory)' \
  test/integration/single-agent-runtime.test.ts
```

Local evidence used Node 24.22.1 on macOS arm64 and the lockfile's official Pi
1.4.0 SDK. The four-case selection also passed native launch receipt,
stale-guidance inspection and metadata inventory. The same four cases separately
passed with the actor fixture selecting the installed fork SDK at
`c37f5730c9a0ebabb05488120f9a42ea97decbfd` through
`PI_SINGLE_AGENT_TEST_SDK`; no runtime was installed or restarted.
This is native fixture evidence, not paid-model or whole-runtime performance
evidence. Full official/fork dependency-graph qualification remains a hosted
delivery gate.
