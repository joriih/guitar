const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const EXPLICIT_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

export type ParsedYouTubeUrl = Readonly<{
  videoId: string;
  startSeconds: number;
  canonicalUrl: string;
}>;

function safeVideoId(value: string | null | undefined): string | null {
  const candidate = value?.trim() ?? "";
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;

  const candidate = value.trim().toLowerCase();
  if (/^\d+$/.test(candidate)) {
    const seconds = Number(candidate);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const clockParts = candidate.split(":");
  if (
    clockParts.length >= 2 &&
    clockParts.length <= 3 &&
    clockParts.every((part) => /^\d+$/.test(part))
  ) {
    const values = clockParts.map(Number);
    const seconds = values.reduce((total, part) => total * 60 + part, 0);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const unitMatch = candidate.match(
    /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/,
  );
  if (!unitMatch || !unitMatch.slice(1).some(Boolean)) return null;

  const seconds =
    Number(unitMatch[1] ?? 0) * 3600 +
    Number(unitMatch[2] ?? 0) * 60 +
    Number(unitMatch[3] ?? 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function timestampFromUrl(url: URL): number {
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParameters = new URLSearchParams(hash);
  const candidates = [
    url.searchParams.get("t"),
    url.searchParams.get("start"),
    hashParameters.get("t"),
    hash && !hash.includes("=") ? hash : null,
  ];

  for (const candidate of candidates) {
    const seconds = parseTimestamp(candidate);
    if (seconds !== null) return Math.max(0, seconds);
  }
  return 0;
}

function videoIdFromUrl(url: URL): string | null {
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (SHORT_HOSTS.has(hostname)) {
    return segments.length === 1 ? safeVideoId(segments[0]) : null;
  }

  if (!YOUTUBE_HOSTS.has(hostname)) return null;

  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    return safeVideoId(url.searchParams.get("v"));
  }

  if (
    segments.length === 2 &&
    ["shorts", "embed", "live"].includes(segments[0]?.toLowerCase() ?? "")
  ) {
    return safeVideoId(segments[1]);
  }

  return null;
}

/** Parses a YouTube video ID or a known watch/share/embed URL shape. */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  const candidate = input.trim();
  if (!candidate) return null;

  const directVideoId = safeVideoId(candidate);
  if (directVideoId) {
    return {
      videoId: directVideoId,
      startSeconds: 0,
      canonicalUrl: `https://www.youtube.com/watch?v=${directVideoId}`,
    };
  }

  const withScheme = EXPLICIT_SCHEME_PATTERN.test(candidate)
    ? candidate
    : `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443")
  ) {
    return null;
  }

  const videoId = videoIdFromUrl(url);
  if (!videoId) return null;

  return {
    videoId,
    startSeconds: timestampFromUrl(url),
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function parseYouTubeVideoId(input: string): string | null {
  return parseYouTubeUrl(input)?.videoId ?? null;
}
