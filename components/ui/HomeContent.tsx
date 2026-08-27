import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Clock3,
  FolderOpen,
  Music2,
  Play,
  Plus,
  SearchX,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { RiffRowActions } from "@/components/library/RiffRowActions";
import type { Tag } from "@/types/domain";
import styles from "./HomeContent.module.css";

export type AlbumSummary = {
  id: string;
  title: string;
  href: string;
  imageSrc: string;
  riffCount: number;
  tuning?: string;
  updatedLabel?: string;
};

export type RecentRiffSummary = {
  id: string;
  title: string;
  href: string;
  album: string;
  albumId?: string | null;
  tags?: Tag[];
  duration: string;
  updatedLabel: string;
  bpm?: number;
  keyName?: string;
  favorite?: boolean;
  revision: number;
};

export const SAMPLE_ALBUMS: AlbumSummary[] = [
  {
    id: "night-drive",
    title: "Night Drive",
    href: "/albums/night-drive",
    imageSrc: "/assets/guitars/olympic-white.avif",
    riffCount: 12,
    tuning: "Drop D",
    updatedLabel: "오늘",
  },
  {
    id: "slow-burn",
    title: "Slow Burn",
    href: "/albums/slow-burn",
    imageSrc: "/assets/guitars/candy-apple-red.avif",
    riffCount: 8,
    tuning: "Standard",
    updatedLabel: "어제",
  },
  {
    id: "green-room",
    title: "Green Room",
    href: "/albums/green-room",
    imageSrc: "/assets/guitars/aged-surf-green.avif",
    riffCount: 17,
    tuning: "D Standard",
    updatedLabel: "3일 전",
  },
  {
    id: "rough-cuts",
    title: "Rough Cuts",
    href: "/albums/rough-cuts",
    imageSrc: "/assets/guitars/black-guard.avif",
    riffCount: 6,
    tuning: "Drop C",
    updatedLabel: "1주 전",
  },
];

export const SAMPLE_RECENT_RIFFS: RecentRiffSummary[] = [
  {
    id: "neon-intro",
    title: "Neon Intro",
    href: "/riffs/neon-intro",
    album: "Night Drive",
    albumId: "night-drive",
    tags: [{ id: "tag-dream-pop", name: "Dream Pop" }],
    duration: "0:42",
    updatedLabel: "12분 전",
    bpm: 128,
    keyName: "Dm",
    favorite: true,
    revision: 0,
  },
  {
    id: "half-light",
    title: "Half Light",
    href: "/riffs/half-light",
    album: "Slow Burn",
    albumId: "slow-burn",
    tags: [{ id: "tag-clean", name: "Clean" }],
    duration: "1:08",
    updatedLabel: "어제",
    bpm: 92,
    keyName: "Am",
    revision: 0,
  },
  {
    id: "room-tone",
    title: "Room Tone 04",
    href: "/riffs/room-tone-04",
    album: "Green Room",
    albumId: "green-room",
    duration: "0:31",
    updatedLabel: "3일 전",
    bpm: 116,
    keyName: "G",
    revision: 0,
  },
];

export type AlbumGalleryProps = {
  albums: AlbumSummary[];
  layout?: "grid" | "list";
  emptyActionHref?: string;
  emptyMode?: "create" | "search";
};

export function AlbumGallery({
  albums,
  layout = "grid",
  emptyActionHref = "/albums/new",
  emptyMode = "create",
}: AlbumGalleryProps) {
  if (albums.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon} aria-hidden="true">
          {emptyMode === "search" ? <SearchX size={22} /> : <FolderOpen size={22} />}
        </span>
        <strong>{emptyMode === "search" ? "일치하는 앨범이 없어요" : "첫 앨범을 만들어보세요"}</strong>
        {emptyMode === "create" ? (
          <Link href={emptyActionHref}>
            <Plus size={15} aria-hidden="true" /> 새 앨범
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${styles.albumGallery} ${layout === "list" ? styles.albumList : ""}`}>
      {albums.map((album, index) => (
        <AlbumCard album={album} key={album.id} layout={layout} eager={index === 0} />
      ))}
    </div>
  );
}

export function AlbumCard({
  album,
  layout = "grid",
  eager = false,
}: {
  album: AlbumSummary;
  layout?: "grid" | "list";
  eager?: boolean;
}) {
  return (
    <article className={`${styles.albumCard} ${layout === "list" ? styles.albumCardList : ""}`}>
      <Link className={styles.albumArtworkLink} href={album.href} aria-label={`${album.title} 앨범 열기`}>
        <div className={styles.albumArtwork}>
          <Image
            className={styles.albumGuitar}
            src={album.imageSrc}
            alt=""
            width={520}
            height={660}
            loading={eager ? "eager" : "lazy"}
            sizes="(max-width: 700px) 78vw, (max-width: 1100px) 34vw, 260px"
          />
        </div>
      </Link>
      <div className={styles.albumInfo}>
        <div className={styles.albumTitleRow}>
          <Link href={album.href}>{album.title}</Link>
          {album.updatedLabel ? <span>{album.updatedLabel}</span> : null}
        </div>
        <p>
          리프 {album.riffCount}개{album.tuning ? ` · ${album.tuning}` : ""}
        </p>
      </div>
    </article>
  );
}

export type RecentRiffListProps = {
  riffs: RecentRiffSummary[];
  emptyActionHref?: string;
  emptyMode?: "create" | "search";
};

export function RecentRiffList({
  riffs,
  emptyActionHref = "/riffs/new",
  emptyMode = "create",
}: RecentRiffListProps) {
  if (riffs.length === 0) {
    return (
      <div className={styles.compactEmpty}>
        {emptyMode === "search" ? <SearchX size={18} /> : <Music2 size={18} />}
        <span>{emptyMode === "search" ? "일치하는 리프가 없어요." : "아직 녹음한 리프가 없어요."}</span>
        {emptyMode === "create" ? <Link href={emptyActionHref}>새 리프</Link> : null}
      </div>
    );
  }

  return (
    <div className={styles.riffList}>
      {riffs.map((riff) => (
        <article className={styles.riffRow} key={riff.id}>
          <Link className={styles.riffPlay} href={riff.href} aria-label={`${riff.title} 열기`}>
            <Play size={15} fill="currentColor" />
          </Link>
          <div className={styles.riffIdentity}>
            <Link href={riff.href}>{riff.title}</Link>
            <div className={styles.riffSubline}>
              <span>{riff.album}</span>
              {riff.tags?.slice(0, 2).map((tag) => (
                <Link
                  className={styles.riffTagLink}
                  href={{ pathname: "/", query: { tag: tag.name } }}
                  aria-label={`${tag.name} 태그로 필터`}
                  key={tag.id}
                >
                  #{tag.name}
                </Link>
              ))}
              {(riff.tags?.length ?? 0) > 2 ? (
                <span className={styles.riffTagMore}>+{riff.tags!.length - 2}</span>
              ) : null}
            </div>
          </div>
          <div className={styles.riffSession}>
            {riff.bpm ? <span>{riff.bpm} BPM</span> : null}
            {riff.keyName ? <span>{riff.keyName}</span> : null}
          </div>
          <span className={styles.riffDuration}>{riff.duration}</span>
          <span className={styles.riffUpdated}>
            <Clock3 size={13} /> {riff.updatedLabel}
          </span>
          <RiffRowActions
            key={`${riff.id}:${riff.revision}`}
            riffId={riff.id}
            title={riff.title}
            initialFavorite={riff.favorite}
            initialAlbumId={riff.albumId}
            initialRevision={riff.revision}
          />
        </article>
      ))}
    </div>
  );
}

export type HomeContentProps = {
  albums?: AlbumSummary[];
  recentRiffs?: RecentRiffSummary[];
  albumLayout?: "grid" | "list";
  title?: string;
  actions?: ReactNode;
  allAlbumsHref?: string;
  allRiffsHref?: string;
  searchQuery?: string;
  totalRiffCount?: number;
  activeFilter?: { label: string; href: string };
};

export function HomeContent({
  albums = SAMPLE_ALBUMS,
  recentRiffs = SAMPLE_RECENT_RIFFS,
  albumLayout = "grid",
  title = "내 앨범",
  actions,
  allAlbumsHref = "/albums",
  allRiffsHref = "/recent",
  searchQuery,
  totalRiffCount,
  activeFilter,
}: HomeContentProps) {
  const isSearch = Boolean(searchQuery?.trim());
  const visibleRiffCount =
    totalRiffCount ?? albums.reduce((total, album) => total + album.riffCount, 0);
  const riffResultsTruncated = isSearch && visibleRiffCount > recentRiffs.length;

  return (
    <div className={styles.home}>
      <div className={styles.pageHeading}>
        <div>
          <h1>{title}</h1>
          <p>
            {riffResultsTruncated
              ? `앨범 ${albums.length}개 · 리프 전체 ${visibleRiffCount}개 · 최근 ${recentRiffs.length}개 표시`
              : `앨범 ${albums.length}개 · 리프 ${visibleRiffCount}개`}
          </p>
        </div>
        {activeFilter || actions ? (
          <div className={styles.headingActions}>
            {activeFilter ? (
              <Link
                className={styles.activeFilter}
                href={activeFilter.href}
                aria-label={`${activeFilter.label} 필터 해제`}
              >
                {activeFilter.label} <X size={13} aria-hidden="true" />
              </Link>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>

      <section className={styles.section} aria-labelledby="albums-heading">
        <div className={styles.sectionHeading}>
          <h2 id="albums-heading">앨범</h2>
          <Link href={allAlbumsHref}>
            모두 보기 <ArrowRight size={15} />
          </Link>
        </div>
        <AlbumGallery albums={albums} layout={albumLayout} emptyMode={isSearch ? "search" : "create"} />
      </section>

      <section className={styles.section} aria-labelledby="recent-heading">
        <div className={styles.sectionHeading}>
          <h2 id="recent-heading">최근 리프</h2>
          <Link href={allRiffsHref}>
            모두 보기 <ArrowRight size={15} />
          </Link>
        </div>
        <RecentRiffList riffs={recentRiffs} emptyMode={isSearch ? "search" : "create"} />
      </section>
    </div>
  );
}
