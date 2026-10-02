# Test ownership

- Keep native receipt, cold-crash, shutdown, continuation and broker safety
  contracts at their actual SDK, journal, filesystem or process boundary.
- Carry distinct assertions into the keeper before deleting a duplicate test.
  Do not add production exports or dependency injection solely for tests.
- Expected values must be independent of the code under test. Observe actual
  publication/readiness before checking negative outcomes; a sleep is not proof
  that the owner processed the input.
- Use `npm run ci` for full validation. Never edit source or tests while checks
  run in this checkout. Qualify official Pi and the intended fork separately;
  matching version numbers do not establish matching runtime behavior.
