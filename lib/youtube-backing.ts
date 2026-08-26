export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const MAX_YOUTUBE_BACKING_NAME_LENGTH = 120;
export const MAX_YOUTUBE_BACKING_START_MS = 86_400_000;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

function cleanVideoId(value: string | null | undefined): string | null {
  const candidate = value?.trim() ?? "";
  return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Accepts canonical, shortened, Shorts, live, and privacy-enhanced YouTube URLs.
 * Arbitrary hosts and lookalike domains are deliberately rejected.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const directId = cleanVideoId(raw);
  if (directId) return directId;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    return cleanVideoId(url.pathname.split("/").filter(Boolean)[0]);
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (url.pathname === "/watch") return cleanVideoId(url.searchParams.get("v"));
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live", "v"].includes(kind ?? "")) {
    return cleanVideoId(id);
  }
  return null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  const normalized = cleanVideoId(videoId);
  if (!normalized) throw new Error("올바른 YouTube 영상 ID가 아니에요.");
  return `https://www.youtube.com/watch?v=${normalized}`;
}

export type YouTubeBackingSource = {
  id: string;
  riffId: string;
  videoId: string;
  url: string;
  name: string;
  sourceStartMs: number;
  volume: number;
  syncEnabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
