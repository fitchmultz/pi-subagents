# Test ownership

- Keep native receipt, cold-crash, shutdown, continuation and broker safety
  contracts at their actual SDK, journal, filesystem or process boundary.
- Carry distinct assertions into the keeper before deleting a duplicate test.
  Do not add production exports or dependency injection solely for tests.
- Expected values must be independent of the code under test. Observe actual
  publication/readiness before checking negative outcomes; a sleep is not proof
  that the owner processed the input.
- The Mac CI leg needs a proved clean guest and official one-job runner. Use
  the attached `node scripts/protected-macos-ci.mjs controller --state "$OPERATOR_ROOT/state.json"`
  through the official SDK owner; follow [docs/code-quality.md](docs/code-quality.md) for
  baseline qualification/sealing, exact source binding and unattended serial replenishment.
  Conditional native controls alone do not authorize activation or qualify first-hook source trust. Never weaken
  native omission assertions or run public-repository jobs as the desktop user.
- Use `npm run ci` for full validation. Never edit source or tests while checks
  run in this checkout. Qualify official Pi and the intended fork separately;
  matching version numbers do not establish matching runtime behavior.

## Code quality, maintainability, and verification

Use the repository's existing npm lockfile, runtime, workspace structure and verification commands.
Preserve compatible verified work. Complete the policy integration and resulting source cleanup.
Treat correctness, long-term maintainability and trustworthy enforcement as equal objectives.

Keep the configured production complexity, size, readonly and safety requirements. A finding need not
identify an existing runtime bug to justify a maintainability improvement. Use authorized semantic
exceptions only when their conditions are demonstrated. Additional relaxations require concrete
evidence and explicit approval. See [docs/code-quality.md](docs/code-quality.md).

Apply type-aware checks to TypeScript and checked JavaScript. Keep other maintained JavaScript covered
by applicable lint, formatting and tests. Run `npm run quality:scope -- --write` after inventory/checkJs
changes and review the generated configuration. Verify declaration-qualified allowances with positive
and negative origin-isolation probes. Keep floating-Promise protection strict.

Preserve accurate API contracts and runtime behavior. Resolve unsafe types with validation, narrowing
and sound type relationships. Use contextual inference where useful. Keep explicit public contracts
and application-owned readonly data intentional. Native permissions retain actual SDK contracts, not
mapped fake immutability. Update the compact mutation registry rather than copied generated overrides.

Refactor large production functions along real responsibilities. Make state ownership, async phases,
failure behavior and cleanup clear. Keep internal APIs private where possible. A single-use helper is
useful when it creates a meaningful boundary. Avoid forwarding layers, arbitrary file splits, giant
shared context objects and speculative frameworks. Preserve ordering, cancellation, deletion guards,
error identity, retries and lifecycle cleanup.

Keep cohesive lifecycle tests together. Tests retain branching and parameter limits but are exempt
from size and statement limits. Correct invalid fixtures while preserving assertions that express the
intended behavior. Verify both isolated and suite execution. Follow test-audit when changing tests.

Run `npm ci --ignore-scripts` and `npm run quality:setup` for a clean development install. Review
`npm run lint:fix` autofixes and the maintainability of the resulting structure. Use `npm run lint:agent`
for agent diagnostics, `npm run format` for formatting, and `npm run ci` for integrated acceptance.
On the clean integrated revision also run `npm run quality:sabotage`; a failing baseline is not proof
that the acceptance workflow catches the injected violations.

Report configuration changes, formatting, maintainability improvements, checker fixes, fixture repairs
and runtime bugs separately. Report commands, results, coverage, exceptions and verification limits
accurately.
