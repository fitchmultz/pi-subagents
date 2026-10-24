# Test ownership

- Keep native receipt, cold-crash, shutdown, continuation and broker safety
  contracts at their actual SDK, journal, filesystem or process boundary.
- Carry distinct assertions into the keeper before deleting a duplicate test.
  Do not add production exports or dependency injection solely for tests.
- Expected values must be independent of the code under test. Observe actual
  publication/readiness before checking negative outcomes; a sleep is not proof
  that the owner processed the input.
- Use `npm run ci` in hosted CI for full validation. Keep local checks narrow.
  Never edit source or tests while checks run in this checkout.
  Qualify official Pi and the intended fork separately;
  matching version numbers do not establish matching runtime behavior.

# Code quality

- Use native APIs and behavior when they meet the requirements; don't reimplement them.

Use the committed npm lockfile. Obtain passing `npm run lint`, `npm run format:check`
and `npm run typecheck` evidence before delivery. `npm run ci` includes these checks and the
package/install smokes and complete test suites. Keep the strict rules in
`.oxlintrc.json` and formatting in `.oxfmtrc.json`; use the published tools directly.
See [Code quality](docs/code-quality.md) for the rules and commands.

# Rule enforcement

| Rule                                                                                          | Enforcement                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep run replies separate from saved results and renderer details.                            | `src/agent/view.ts` owns receipt, inventory and inspection rendering; raw projections and the generic reply constructor are private. TypeScript rejects the old imports. The native inventory and child-usage keepers run in `npm run ci`. |
| Preserve native receipt, crash, shutdown, continuation and broker contracts.                  | `single-agent-runtime`, `agent-receipts` and `pi-intercom-native-replay` exercise their real owners in hosted CI. New or transferred assertions still need test-ownership review.                                                          |
| Use independent expectations and observe the relevant publication before negative assertions. | Native journal/process/socket assertions enforce the named cases. Test-authoring review must identify the operation-specific processing barrier; no general static check can prove asynchronous readiness.                                 |
| Keep strict lint, formatting, types and the committed dependency graph.                       | `npm ci`, `npm run lint`, `npm run format:check`, `npm run typecheck` and the aggregate hosted compatibility gate.                                                                                                                         |
| Qualify official Pi and the intended fork separately.                                         | `.github/workflows/ci.yml`, `ci-host.mjs` and `compat-host.mjs` select and verify each actual dependency graph.                                                                                                                            |

Local check scope, avoiding edits during checks, choosing native APIs, test
transfers, dependency-release review and rollout authorization remain judgment
calls. The checks above do not claim to automate them. See
[repeated corrections](docs/corrections.md) for historical rejection evidence.

# Dependency maintenance

- Frequently review and proactively update maintained packages and all runtime,
  development, build, test, and tooling dependencies. Routine in-scope updates are
  authorized; do not wait for breakage. Prioritize the latest stable official Pi
  release and intended `fitchmultz/pi` revision, qualifying them separately.
- Review release, changelog, migration, and security notes across the upgrade
  range; check actual supported APIs and behavior, not version numbers alone.
  Preserve support floors, standalone use, optional integration boundaries, and
  the committed npm lockfile policy; update compatible manifest/lockfile cohorts.
- Adopt beneficial current APIs, conventions, patterns, and functionality instead
  of extending deprecated or outdated approaches. Align callers, documentation,
  generated schemas, fixtures, and packaged resources with the owning contracts.
- Carry updates through the required local checks above, focused native and
  package/install checks, required review, and hosted CI. Keep full `npm run ci`
  hosted-only. Record exact target identities, failures, skips, and limits; never
  weaken checkers, safety, or support floors to pass an update.
- Roll out through existing approval, release, and installation gates with a
  recoverable prior version and rollback plan; honor explicit holds. This
  authorization does not itself permit publication, active-runtime
  installation/restarts, private-data disclosure, or global model/auth changes.
