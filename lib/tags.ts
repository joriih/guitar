export const MAX_TAG_NAME_LENGTH = 32;
export const MAX_TAGS_PER_RIFF = 12;

export function cleanTagName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTagName(value: string): string {
  return cleanTagName(value).toLocaleLowerCase("ko-KR");
}
