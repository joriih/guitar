const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export function normalizedDatabaseHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function assertLoopbackDatabaseUrl(
  value: string,
  label = "DATABASE_URL",
): URL {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label}은 PostgreSQL 주소여야 해요.`);
  }
  if (!LOOPBACK_HOSTNAMES.has(normalizedDatabaseHostname(url))) {
    throw new Error(`${label}은 이 Mac의 PostgreSQL만 사용할 수 있어요.`);
  }
  return url;
}
