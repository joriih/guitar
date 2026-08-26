export const ALBUM_COVERS = [
  { src: "/assets/guitars/olympic-white.avif", label: "블랙 텔레" },
  { src: "/assets/guitars/candy-apple-red.avif", label: "실버 스트랫" },
  { src: "/assets/guitars/aged-surf-green.avif", label: "트랜스 레드" },
  { src: "/assets/guitars/black-guard.avif", label: "릴릭 실버 텔레" },
  { src: "/assets/guitars/sonic-blue.avif", label: "브라운 선버스트" },
  { src: "/assets/guitars/vintage-sunburst.webp", label: "빈티지 선버스트" },
  { src: "/assets/guitars/natural-acoustic.webp", label: "내추럴 어쿠스틱" },
  { src: "/assets/guitars/mahogany-parlor.webp", label: "마호가니 팔러" },
  { src: "/assets/guitars/cherry-semi-hollow.webp", label: "체리 세미할로우" },
  { src: "/assets/guitars/ivory-offset.webp", label: "아이보리 오프셋" },
  { src: "/assets/guitars/butterscotch-single-cut.webp", label: "버터스카치 싱글컷" },
  { src: "/assets/guitars/midnight-blue-double-cut.webp", label: "미드나이트 블루" },
  { src: "/assets/guitars/matte-black-bass.webp", label: "매트 블랙 베이스" },
  { src: "/assets/guitars/sunburst-short-scale-bass.webp", label: "선버스트 베이스" },
] as const;

export type AlbumCoverPath = (typeof ALBUM_COVERS)[number]["src"];

// Keep the picker, API allow-list, and Zod enum on one catalog. Adding a real
// asset only requires one entry above; consumers should not maintain a second
// path list.
export const ALBUM_COVER_PATHS: readonly AlbumCoverPath[] = ALBUM_COVERS.map(
  ({ src }) => src,
);

const ALBUM_COVER_PATH_SET = new Set<string>(ALBUM_COVER_PATHS);

export function isAllowedAlbumCover(value: unknown): value is AlbumCoverPath {
  return typeof value === "string" && ALBUM_COVER_PATH_SET.has(value);
}

export const DEFAULT_ALBUM_COVER = ALBUM_COVERS[0].src;
