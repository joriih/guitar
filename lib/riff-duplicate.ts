const RIFF_TITLE_LIMIT = 120;
const COPY_SUFFIX = " 복사본";

export function duplicateRiffTitle(title: string): string {
  const base = title.trim() || "새 리프";
  const availableCharacters =
    RIFF_TITLE_LIMIT - Array.from(COPY_SUFFIX).length;
  return `${Array.from(base).slice(0, availableCharacters).join("")}${COPY_SUFFIX}`;
}
