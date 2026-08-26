import type { AlbumSummary } from "@/components/ui";
import { ALBUM_COVER_PATHS } from "@/lib/album-covers";
import type { Album } from "@/types/domain";

import { relativeDate } from "./format";

export function albumSummary(album: Album, index: number): AlbumSummary {
  return {
    id: album.id,
    title: album.name,
    href: `/albums/${album.id}`,
    imageSrc: album.coverAsset || ALBUM_COVER_PATHS[index % ALBUM_COVER_PATHS.length],
    riffCount: album.riffCount,
    updatedLabel: relativeDate(album.updatedAt),
  };
}
