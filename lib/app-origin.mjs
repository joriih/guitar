export const DEFAULT_APP_ORIGIN = "http://127.0.0.1:3000";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const REMOTE_ACCESS_ENABLED = "1";
const REMOTE_ACCESS_DISABLED = "0";

function normalizedHostname(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Parse an app origin without accepting URL prefixes, paths, credentials, or
 * alternate spellings. Keeping one canonical spelling makes later equality
 * checks exact rather than suffix- or prefix-based.
 */
export function normalizeAppOrigin(value) {
  if (!value || value !== value.trim()) {
    throw new Error("APP_ORIGIN must be an exact origin.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN must be a valid URL origin.");
  }

  if (
    value !== url.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("APP_ORIGIN must contain only a canonical origin.");
  }

  const loopback = LOOPBACK_HOSTNAMES.has(normalizedHostname(url));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Non-loopback APP_ORIGIN values must use HTTPS.");
  }

  return url.origin;
}

export function isLoopbackAppOrigin(value) {
  try {
    const origin = normalizeAppOrigin(value);
    return LOOPBACK_HOSTNAMES.has(normalizedHostname(new URL(origin)));
  } catch {
    return false;
  }
}

/**
 * Resolve the complete origin allowlist. Remote access is deliberately a
 * two-part configuration: an exact HTTPS APP_ORIGIN plus RIFF_REMOTE_ACCESS=1.
 * A partial or mistyped configuration fails closed.
 */
export function allowedAppOrigins(
  configuredOrigin = process.env.APP_ORIGIN,
  remoteAccessValue = process.env.RIFF_REMOTE_ACCESS,
) {
  if (
    remoteAccessValue !== undefined &&
    remoteAccessValue !== REMOTE_ACCESS_DISABLED &&
    remoteAccessValue !== REMOTE_ACCESS_ENABLED
  ) {
    throw new Error("RIFF_REMOTE_ACCESS must be either 0 or 1.");
  }

  if (configuredOrigin === undefined) {
    if (remoteAccessValue === REMOTE_ACCESS_ENABLED) {
      throw new Error("Remote access requires an exact HTTPS APP_ORIGIN.");
    }
    return Object.freeze([DEFAULT_APP_ORIGIN]);
  }

  const configured = normalizeAppOrigin(configuredOrigin);
  const configuredIsLoopback = isLoopbackAppOrigin(configured);
  if (remoteAccessValue === REMOTE_ACCESS_ENABLED) {
    if (configuredIsLoopback || !configured.startsWith("https://")) {
      throw new Error("Remote access requires a non-loopback HTTPS APP_ORIGIN.");
    }
  } else if (!configuredIsLoopback) {
    throw new Error("External APP_ORIGIN requires RIFF_REMOTE_ACCESS=1.");
  }

  return Object.freeze([...new Set([DEFAULT_APP_ORIGIN, configured])]);
}

export function isAllowedAppOrigin(
  origin,
  configuredOrigin = process.env.APP_ORIGIN,
  remoteAccessValue = process.env.RIFF_REMOTE_ACCESS,
) {
  if (origin === null) return false;

  let normalized;
  try {
    normalized = normalizeAppOrigin(origin);
  } catch {
    return false;
  }
  return allowedAppOrigins(configuredOrigin, remoteAccessValue).includes(normalized);
}

/**
 * Derive Secure-cookie policy from the validated browser Origin rather than a
 * spoofable forwarded-protocol header or the loopback proxy request URL.
 */
export function isSecureAppRequest(
  request,
  configuredOrigin = process.env.APP_ORIGIN,
  remoteAccessValue = process.env.RIFF_REMOTE_ACCESS,
) {
  const origin = request.headers.get("origin");
  return (
    isAllowedAppOrigin(origin, configuredOrigin, remoteAccessValue) &&
    origin !== null &&
    new URL(origin).protocol === "https:"
  );
}
