import type { RecentRiffSummary } from "@/components/ui";
import type { Riff } from "@/types/domain";

export function relativeDate(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 2) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days === 1) return "어제";
  if (days < 14) return `${days}일 전`;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function riffSummary(
  riff: Riff,
  albumName: string,
): RecentRiffSummary {
  return {
    id: riff.id,
    title: riff.title,
    href: `/riffs/${riff.id}`,
    album: albumName,
    albumId: riff.albumId,
    tags: riff.tags,
    duration: riff.takeCount ? `테이크 ${riff.takeCount}개` : "새 리프",
    updatedLabel: relativeDate(riff.updatedAt),
    bpm: riff.bpm,
    keyName: riff.musicalKey,
    favorite: riff.isFavorite,
    revision: riff.revision,
  };
}
