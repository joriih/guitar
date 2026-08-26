import { redirect } from "next/navigation";

import { AppShell, HomeContent, type AlbumSummary, type RecentRiffSummary } from "@/components/ui";
import { ALBUM_COVER_PATHS } from "@/lib/album-covers";
import {
  countRiffs,
  getCurrentUser,
  hasAppUser,
  listAlbums,
  listRiffAlbumIds,
  listRiffs,
} from "@/lib/data";
import { cleanTagName } from "@/lib/tags";

export const dynamic = "force-dynamic";

function relativeDate(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 2) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days === 1) return "어제";
  if (days < 14) return `${days}일 전`;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value));
}

type HomePageProps = {
  searchParams: Promise<{ view?: string; q?: string; tag?: string }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const [configured, user] = await Promise.all([hasAppUser(), getCurrentUser()]);
  if (!configured) redirect("/setup");
  if (!user) redirect("/login");

  const query = await searchParams;
  const rawKeyword = query.q?.trim() ?? "";
  const tagFilter = query.tag ? cleanTagName(query.tag) : "";
  const isFiltering = Boolean(rawKeyword || tagFilter);
  const riffFilters = {
    search: rawKeyword || undefined,
    tagName: tagFilter || undefined,
  };
  const [albums, recentRiffs, filteredRiffCount, filteredAlbumIds] = await Promise.all([
    listAlbums(),
    listRiffs({
      ...riffFilters,
      limit: isFiltering ? 200 : 12,
    }),
    isFiltering ? countRiffs(riffFilters) : Promise.resolve(null),
    tagFilter ? listRiffAlbumIds(riffFilters) : Promise.resolve([]),
  ]);
  const albumNames = new Map(albums.map((album) => [album.id, album.name]));

  const allAlbumCards: AlbumSummary[] = albums.map((album, index) => ({
    id: album.id,
    title: album.name,
    href: `/albums/${album.id}`,
    imageSrc: album.coverAsset || ALBUM_COVER_PATHS[index % ALBUM_COVER_PATHS.length],
    riffCount: album.riffCount,
    updatedLabel: relativeDate(album.updatedAt),
  }));

  const allRiffRows: RecentRiffSummary[] = recentRiffs.map((riff) => ({
    id: riff.id,
    title: riff.title,
    href: `/riffs/${riff.id}`,
    album: riff.albumId ? albumNames.get(riff.albumId) ?? "내 앨범" : "분류되지 않음",
    albumId: riff.albumId,
    tags: riff.tags,
    duration: riff.takeCount ? `테이크 ${riff.takeCount}개` : "새 리프",
    updatedLabel: relativeDate(riff.updatedAt),
    bpm: riff.bpm,
    keyName: riff.musicalKey,
    favorite: riff.isFavorite,
    revision: riff.revision,
  }));

  const view = query.view === "list" ? "list" : "grid";
  const preservedParams = new URLSearchParams();
  if (rawKeyword) preservedParams.set("q", rawKeyword);
  if (tagFilter) preservedParams.set("tag", tagFilter);
  const searchSuffix = preservedParams.size ? `&${preservedParams.toString()}` : "";
  const keyword = rawKeyword.replace(/^#+/, "").toLocaleLowerCase("ko-KR");
  const matchingAlbumIds = new Set(filteredAlbumIds);
  const albumCards = allAlbumCards.filter((album) => {
    if (tagFilter && !matchingAlbumIds.has(album.id)) return false;
    return !keyword || album.title.toLocaleLowerCase("ko-KR").includes(keyword);
  });
  const title = tagFilter
    ? rawKeyword
      ? `#${tagFilter} · “${rawKeyword}”`
      : `#${tagFilter} 태그`
    : rawKeyword
      ? `“${rawKeyword}” 검색 결과`
      : "내 앨범";
  const clearFilterParams = new URLSearchParams();
  if (rawKeyword) clearFilterParams.set("q", rawKeyword);
  if (view === "list") clearFilterParams.set("view", "list");
  const clearFilterHref = clearFilterParams.size
    ? `/?${clearFilterParams.toString()}`
    : "/";

  return (
    <AppShell
      currentSection="home"
      newHref="/riffs/new"
      searchAction="/"
      searchDefaultValue={query.q}
      user={{ name: user.displayName, subtitle: `@${user.username}` }}
      view={view}
      gridHref={`/?view=grid${searchSuffix}`}
      listHref={`/?view=list${searchSuffix}`}
    >
      <HomeContent
        albums={albumCards}
        recentRiffs={allRiffRows}
        albumLayout={view}
        title={title}
        searchQuery={rawKeyword || tagFilter}
        totalRiffCount={filteredRiffCount ?? undefined}
        activeFilter={tagFilter ? { label: `#${tagFilter}`, href: clearFilterHref } : undefined}
        allAlbumsHref="/albums"
        allRiffsHref="/recent"
      />
    </AppShell>
  );
}
