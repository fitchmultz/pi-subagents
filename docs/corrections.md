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

## Keyboard and mouse history drift apart

Three distinct faults in [PR #233](https://github.com/fitchmultz/pi-subagents/pull/233):

- Review comment `4356105180`: a mouse history callback captured a stale
  observation client.
- Review comment `4356143823`: the mouse path dropped the history destination
  anchor that keyboard navigation preserved.
- Review comment `4356289488`: the mouse destination landed at the wrong edge of
  an overlap card taller than the viewport.

**Level: architecture, reinforced by discriminated events and native UI checks.**
`Reading` now owns the history operation and destination for both input paths.
The transcript emits typed history, content or pending events instead of an
optional anchor/direction/gap tuple. It no longer stores a second observation
client or synchronizes itself from a mouse callback. The screen refreshes from
its current connection for either input path.

There is no higher level than removing the alternate owner. Types alone cannot
establish the correct visible destination for a tall card. The existing native
observer keeper now clicks both history controls after keyboard/content-page
navigation and checks the rendered earlier/overlap rows. All prior assertions,
including the idle-provider check, remain.

### Rejection evidence

The actual pre-fix `observe-reading.ts` and `observe-transcript.ts` from
`26356263^` (`0e4ee5eb`) were transplanted onto the current fixture in an isolated
worktree. The expanded native observer keeper failed specifically at the
taller-than-viewport mouse assertion: it remained at the bottom of `HISTORY_33`
instead of exposing the preceding activity. This exercises the old sources
against the current fixture, not the entire historical dependency graph.

```sh
node --test --test-name-pattern='native observer caches completed metadata' \
  test/integration/agent-observe.test.ts
```

The same keeper passed on the candidate with official Pi 1.4.0 and separately
with the installed fork at `c37f5730c9a0ebabb05488120f9a42ea97decbfd`.
The focused viewer/journal selection passed seven cases on each target. Native
terminal input and rendered rows supply the mouse/key evidence; these checks
make no paid model calls.
