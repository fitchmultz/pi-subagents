# Code quality

The [Strict Oxlint/Oxfmt Engineering Standard v5.2](strict-oxlint-oxfmt-standard.md)
owns the policy. [Quality exceptions](quality-exceptions.md) records the few
operations that require different treatment. No finding budget or suppression
baseline is accepted.

## Commands

Use the committed npm lockfile. Local checks are:

```sh
npm ci --ignore-scripts
npm run lint
npm run format:check
npm run typecheck
npm run typecheck:declarations
npm run check:quality
npm run build
```

`npm run lint:fix` and `npm run format` are writing conveniences.
`npm run lint:agent` is another output format for the same lint gate.

Full `npm run ci` remains hosted-only. It runs each independent gate even when
another fails: native lint, format, implementation types, handwritten declaration
types, policy and coverage, package size, package/install smokes, unit tests, and
integration tests. Package smokes build the actual artifacts before testing them.
The aggregate fails if any gate fails.

CI qualifies official Pi on Linux and the maintained fork on Linux and macOS.
Those are distinct runtime graphs, not interchangeable version labels. Android
has no published oxlint-tsgolint backend; native semantic qualification runs on
a supported host. A skipped local native probe is not hosted acceptance.

## Coverage and enforcement

`quality/check.ts` compares the effective policy with the normative JSON in the
standard and the explicit repository mappings. It checks native lint membership,
resolved compiler membership, formatter ownership, and required command scope.
The inventory includes ignored files outside generated, dependency, and private
runtime trees, so hiding maintained code with a Git ignore does not exempt it.

The compiler's own resolution checks production dependencies on test support,
including aliases, re-exports, and literal dynamic imports. Oxc's parser identifies
actual comments and operation-bound directives. Strings containing example
directives are data. Copied, moved, duplicate, stale, and wrong-operation
directives fail; unused directives also fail native lint.

The source profiles are:

- `src/**`, `scripts/**`, `quality/**`, and `.github/scripts/**` are production
  implementation. Mixed-use helpers retain that profile.
- `test/**` contains tests, fixtures, and exclusively test-used support.
- `*.test-d.{ts,mts,cts}` are compiler-checked negative consumer contracts with
  explained expected failures and passing counterparts.
- Handwritten `*.d.{ts,mts,cts}` files receive the declaration profile and an
  actual `skipLibCheck:false` check through `quality/declarations.ts`.

The root `tsconfig.json` checks all maintained TS and JS with the full required
strict options. The application retains `skipLibCheck:true` because the installed
SDK dependency closure includes incompatible third-party declaration imports.
The declaration gate checks any handwritten declarations and their real dependency
closure without that option or permissive stubs. There are currently no handwritten
declaration files.

`tsconfig.build.json` and `tsconfig.client.json` are emission configurations, not
substitutes for the checked root project. Build-swap tests, packed-consumer type
tests, and actual package/native-install smokes verify their outputs.

Production limits are complexity 10, depth 3, parameters 4, statements 40,
function lines 80, and file lines 500. Tests retain complexity 15, depth 4, and
parameters 6 without statement or line limits. These are the standard's profiles,
not local exceptions. There is no React, DOM JSX, Jest, or Vitest implementation;
Node's test runner owns execution. A real failing assertion is qualified through
the repository test command.

Oxfmt owns supported maintained files, with width 100, two spaces, LF, double
quotes, and no import/package/Tailwind/JSDoc transformations. npm owns
`package-lock.json`; the build owns `dist/**` and temporary publication trees.
Captured `docs/evidence/*.log` files retain original command bytes. Git, Pi state,
dependency trees, npm cache, and OS metadata are not maintained source.
No committed generated output requires a separate freshness generator.

The existing viewer import restriction remains: lazy viewer values must come
from the selected host through `observe-layout.ts`. It strengthens the base
policy and protects runtime identity. The existing 1 MiB production-byte ceiling
also remains. Neither is a new requirement of this standard.

## Adoption record

Repository: `fitchmultz/pi-subagents`. Standard: v5.2, 3 November 2026.
Runtime: Node `>=24.22.3 <25 || >=26.13.1`, npm, committed lockfile.
Qualified tools: Oxlint 1.91.0, oxlint-tsgolint 7.0.2006, Oxfmt 0.76.0,
TypeScript 7.0.2, oxc-parser 0.157.0, and `@types/node` 24.19.2.

The adoption starts at `7f449e2dcc8e7e82432bea79a2709f0b49256239`.
The adoption PR records the exact integrated head and hosted results; CI verifies
the source SHA before qualification. Local M1 evidence uses Node 24.22.1 and
official Pi 1.5.0; separate native fork coverage runs against its selected graph.

Qualification lives in `strict-oxlint-qualification.test.ts`,
`lint-node-test-allowance.test.ts`, `quality-coverage.test.ts`,
`strict-oxlint-policy.test.ts`, and `quality-acceptance.test.ts`.
These cover semantic and category rules, all six structural boundaries, Node
registration origins, operation attachment, strict JS/TS/declaration checking,
formatting idempotence, coverage omissions, and acceptance exit propagation.
The adoption also exercised each aggregate gate's failure independently; ordinary
regression coverage retains one representative failure plus the all-green case.

The policy and source repairs are integrated. Completion requires the adoption
PR's exact-head hosted checks and release verification; local passes alone do not
establish complete adoption.
