// Vitest setup for the server project.
//
// Test isolation (AC4): any test that constructs the server without an explicit
// dbPath must NOT touch the developer's real app-data registry DB. We default the
// registry to an in-memory database here — it runs before config.ts is imported,
// so `DB_PATH = resolveDbPath()` picks this up. Tests that need real on-disk
// persistence (e.g. the restart-survival integration test) pass an explicit
// dbPath to createServer(), which overrides this default.
if (!process.env.DEVOS_DB_PATH) {
  process.env.DEVOS_DB_PATH = ':memory:';
}
