const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
export const DEFAULT_POSTGRES_ADMIN_USERNAME = "postgres";

function nonEmptyEnvironmentValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolvePostgresAdminUsername(environment = process.env) {
  return (
    nonEmptyEnvironmentValue(environment.PG_ADMIN_USER) ??
    nonEmptyEnvironmentValue(environment.USER) ??
    nonEmptyEnvironmentValue(environment.LOGNAME) ??
    DEFAULT_POSTGRES_ADMIN_USERNAME
  );
}

export function normalizedDatabaseHostname(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function assertLoopbackDatabaseUrl(value, label = "DATABASE_URL") {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label}은 PostgreSQL 주소여야 해요.`);
  }
  if (!LOOPBACK_HOSTNAMES.has(normalizedDatabaseHostname(url))) {
    throw new Error(`${label}은 이 Mac의 PostgreSQL만 사용할 수 있어요.`);
  }
  return url;
}
