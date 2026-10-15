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

Use the committed npm lockfile. Obtain passing `npm run lint`, `npm run format:check`
and `npm run typecheck` evidence before delivery. `npm run ci` includes these checks and the
package/install smokes and complete test suites. Keep the strict rules in
`.oxlintrc.json` and formatting in `.oxfmtrc.json`; use the published tools directly.
See [Code quality](docs/code-quality.md) for the rules and commands.
