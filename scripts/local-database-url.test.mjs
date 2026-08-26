import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLoopbackDatabaseUrl,
  DEFAULT_POSTGRES_ADMIN_USERNAME,
  normalizedDatabaseHostname,
  resolvePostgresAdminUsername,
} from "./local-database-url.mjs";

test("PostgreSQL loopback URLs accept IPv4, localhost, and bracketed IPv6", () => {
  for (const source of [
    "postgresql://user@127.0.0.1:5432/database",
    "postgres://user@localhost/database",
    "postgresql://user@[::1]:5432/database",
  ]) {
    const url = assertLoopbackDatabaseUrl(source);
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(normalizedDatabaseHostname(url)));
  }
});

test("non-PostgreSQL protocols and non-loopback hosts fail closed", () => {
  for (const source of [
    "http://localhost/database",
    "postgresql://user@192.168.0.2/database",
    "postgresql://user@database.example/database",
    "postgresql://user@0.0.0.0/database",
  ]) {
    assert.throws(() => assertLoopbackDatabaseUrl(source));
  }
});

test("PostgreSQL admin identity uses explicit, OS, then generic fallbacks", () => {
  assert.equal(
    resolvePostgresAdminUsername({
      PG_ADMIN_USER: "  database_owner  ",
      USER: "local-user",
      LOGNAME: "login-user",
    }),
    "database_owner",
  );
  assert.equal(
    resolvePostgresAdminUsername({ USER: "local-user", LOGNAME: "login-user" }),
    "local-user",
  );
  assert.equal(
    resolvePostgresAdminUsername({ USER: "", LOGNAME: "login-user" }),
    "login-user",
  );
  assert.equal(resolvePostgresAdminUsername({}), DEFAULT_POSTGRES_ADMIN_USERNAME);
  assert.equal(DEFAULT_POSTGRES_ADMIN_USERNAME, "postgres");
});
