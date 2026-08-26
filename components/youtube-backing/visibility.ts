export type RectLike = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}>;

export type ViewportSize = Readonly<{
  width: number;
  height: number;
}>;

export const MIN_VISIBLE_PLAYER_SIZE = 200;
export const MOSTLY_VISIBLE_RATIO = 0.5;

/** Pure geometry used by the player handle and its Node tests. */
export function isRectMostlyVisible(
  rect: RectLike,
  viewport: ViewportSize,
): boolean {
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    rect.width < MIN_VISIBLE_PLAYER_SIZE ||
    rect.height < MIN_VISIBLE_PLAYER_SIZE ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return false;
  }

  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, viewport.width) - Math.max(rect.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0),
  );
  const area = rect.width * rect.height;
  const visibleArea = visibleWidth * visibleHeight;
  return area > 0 && visibleArea / area > MOSTLY_VISIBLE_RATIO;
}
