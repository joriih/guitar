// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { formatMusicXmlChordSymbol, musicXmlPitchLabel, musicXmlPitchToNoteName, resolveMusicXmlChordKind, type ChordPatternName, type NoteName } from "./music-theory.ts";

export const MAX_MUSIC_XML_BYTES = 2 * 1024 * 1024;
export const MAX_MUSIC_XML_MEASURES = 512;
export const MAX_MUSIC_XML_HARMONIES = 2_048;

const MAX_XML_ELEMENTS = 50_000;
const MAX_XML_DEPTH = 128;

export type MusicXmlParseErrorCode =
  | "empty"
  | "too-large"
  | "unsafe-xml"
  | "malformed"
  | "unsupported-score"
  | "too-many-measures"
  | "too-many-harmonies";

export class MusicXmlParseError extends Error {
  readonly code: MusicXmlParseErrorCode;

  constructor(code: MusicXmlParseErrorCode, message: string) {
    super(message);
    this.name = "MusicXmlParseError";
    this.code = code;
  }
}

export type MusicXmlPitch = {
  step: string;
  alter: number;
  label: string;
  noteName: NoteName;
};

export type MusicXmlHarmony = {
  id: string;
  uniqueKey: string;
  measureIndex: number;
  root: MusicXmlPitch;
  kindValue: string;
  kindText: string;
  patternName: ChordPatternName | null;
  bass: MusicXmlPitch | null;
  symbol: string;
};

export type MusicXmlEnding = {
  number: string;
  type: "start" | "stop" | "discontinue";
};

export type MusicXmlMeasure = {
  index: number;
  number: string;
  harmonies: MusicXmlHarmony[];
  repeatStart: boolean;
  repeatEnd: boolean;
  repeatTimes: number | null;
  endings: MusicXmlEnding[];
  newSystem: boolean;
};

export type MusicXmlChordChart = {
  title: string;
  key: {
    fifths: number;
    mode: string | null;
  } | null;
  time: {
    beats: string;
    beatType: string;
  } | null;
  measures: MusicXmlMeasure[];
  harmonies: MusicXmlHarmony[];
};

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string[];
};

const STANDARD_MUSIC_XML_DOCTYPE = /^<!DOCTYPE\s+score-(partwise|timewise)\s+PUBLIC\s+"-\/\/Recordare\/\/DTD MusicXML\s+[0-9]+(?:\.[0-9]+)*\s+(Partwise|Timewise)\/\/EN"\s+"https?:\/\/(?:www\.)?musicxml\.org\/dtds\/(partwise|timewise)\.dtd"\s*>$/i;

function parseError(code: MusicXmlParseErrorCode, message: string): never {
  throw new MusicXmlParseError(code, message);
}

function utf8ByteLength(value: string): number {
  if (value.length > MAX_MUSIC_XML_BYTES) return value.length;
  return new TextEncoder().encode(value).byteLength;
}

function stripSafeStandardDoctype(source: string): string {
  if (/<!ENTITY\b/i.test(source)) {
    parseError("unsafe-xml", "안전을 위해 외부 개체(ENTITY)가 포함된 XML은 열 수 없어요.");
  }

  const doctypeStart = source.search(/<!DOCTYPE\b/i);
  if (doctypeStart < 0) return source;
  const doctypeEnd = source.indexOf(">", doctypeStart);
  if (doctypeEnd < 0) {
    parseError("unsafe-xml", "안전을 위해 확인할 수 없는 문서 형식(DOCTYPE)은 열 수 없어요.");
  }

  const declaration = source.slice(doctypeStart, doctypeEnd + 1);
  if (!STANDARD_MUSIC_XML_DOCTYPE.test(declaration)) {
    parseError(
      "unsafe-xml",
      "안전을 위해 표준 MusicXML 이외의 문서 형식(DOCTYPE)은 열 수 없어요.",
    );
  }

  const withoutDoctype = `${source.slice(0, doctypeStart)}${source.slice(doctypeEnd + 1)}`;
  if (/<!DOCTYPE\b/i.test(withoutDoctype)) {
    parseError("unsafe-xml", "안전을 위해 DOCTYPE이 여러 개인 XML은 열 수 없어요.");
  }
  return withoutDoctype;
}

function decodeXml(value: string): string {
  const entityPattern = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi;
  if (value.replaceAll(entityPattern, "").includes("&")) {
    parseError("unsafe-xml", "XML 안에 지원하지 않는 외부 개체가 있어요.");
  }

  return value.replaceAll(entityPattern, (entity, body: string) => {
    const named: Readonly<Record<string, string>> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    const namedValue = named[body.toLowerCase()];
    if (namedValue !== undefined) return namedValue;

    const hexadecimal = body[1]?.toLowerCase() === "x";
    const numeric = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    const validCodePoint = Number.isInteger(numeric)
      && numeric > 0
      && numeric <= 0x10ffff
      && !(numeric >= 0xd800 && numeric <= 0xdfff);
    if (!validCodePoint) {
      parseError("malformed", "XML 안에 읽을 수 없는 문자 코드가 있어요.");
    }
    return String.fromCodePoint(numeric);
  });
}

function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let rest = source;

  while (rest.trim()) {
    const match = rest.match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!match) parseError("malformed", "XML 태그의 속성 형식이 올바르지 않아요.");
    const name = localName(match[1]);
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      parseError("malformed", "XML 태그에 같은 속성이 두 번 들어 있어요.");
    }
    attributes[name] = decodeXml(match[3] ?? match[4] ?? "");
    rest = rest.slice(match[0].length);
  }

  return attributes;
}

function parseXmlTree(source: string): XmlNode {
  const documentNode: XmlNode = { name: "#document", attributes: {}, children: [], text: [] };
  const stack = [documentNode];
  let cursor = 0;
  let elementCount = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      const tail = decodeXml(source.slice(cursor));
      if (stack.length === 1 && tail.trim()) {
        parseError("malformed", "XML 문서 바깥에 알 수 없는 글자가 있어요.");
      }
      stack.at(-1)?.text.push(tail);
      cursor = source.length;
      break;
    }

    const rawText = decodeXml(source.slice(cursor, open));
    if (stack.length === 1 && rawText.trim()) {
      parseError("malformed", "XML 문서 바깥에 알 수 없는 글자가 있어요.");
    }
    stack.at(-1)?.text.push(rawText);

    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close < 0 || source.slice(open + 4, close).includes("--")) {
        parseError("malformed", "XML 주석이 올바르게 닫히지 않았어요.");
      }
      cursor = close + 3;
      continue;
    }

    if (source.startsWith("<?", open)) {
      const close = source.indexOf("?>", open + 2);
      if (close < 0) parseError("malformed", "XML 선언이 올바르게 닫히지 않았어요.");
      cursor = close + 2;
      continue;
    }

    if (source.startsWith("<![CDATA[", open)) {
      const close = source.indexOf("]]>", open + 9);
      if (close < 0) parseError("malformed", "XML의 CDATA 영역이 올바르게 닫히지 않았어요.");
      if (stack.length === 1) parseError("malformed", "XML 문서 바깥에 CDATA가 있어요.");
      stack.at(-1)?.text.push(source.slice(open + 9, close));
      cursor = close + 3;
      continue;
    }

    if (source.startsWith("<!", open)) {
      parseError("unsafe-xml", "안전을 위해 지원하지 않는 XML 선언은 열 수 없어요.");
    }

    const close = findTagEnd(source, open + 1);
    if (close < 0) parseError("malformed", "XML 태그가 올바르게 닫히지 않았어요.");
    let tag = source.slice(open + 1, close).trim();

    if (tag.startsWith("/")) {
      const closingName = localName(tag.slice(1).trim());
      if (!/^[A-Za-z_][\w.-]*$/.test(closingName) || stack.length === 1) {
        parseError("malformed", "XML 닫기 태그의 위치가 올바르지 않아요.");
      }
      const current = stack.at(-1);
      if (!current || current.name !== closingName) {
        parseError("malformed", "XML 태그의 여닫는 순서가 맞지 않아요.");
      }
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const selfClosing = tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1).trimEnd();
    const nameMatch = tag.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/);
    if (!nameMatch) parseError("malformed", "XML 태그 이름을 읽을 수 없어요.");
    const node: XmlNode = {
      name: localName(nameMatch[1]),
      attributes: parseAttributes(nameMatch[2]),
      children: [],
      text: [],
    };
    elementCount += 1;
    if (elementCount > MAX_XML_ELEMENTS) {
      parseError("too-large", "코드표의 XML 요소가 너무 많아요. 더 작은 파일로 나눠 주세요.");
    }
    stack.at(-1)?.children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_XML_DEPTH) {
        parseError("malformed", "XML 태그가 너무 깊게 겹쳐 있어요.");
      }
    }
    cursor = close + 1;
  }

  if (stack.length !== 1) parseError("malformed", "닫히지 않은 XML 태그가 있어요.");
  if (documentNode.children.length !== 1) {
    parseError("malformed", "MusicXML 문서의 최상위 요소는 하나여야 해요.");
  }
  return documentNode.children[0];
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((candidate) => candidate.name === name);
}

function nodeText(node: XmlNode | undefined): string {
  if (!node) return "";
  const nested = node.children.flatMap((descendant) => [nodeText(descendant)]);
  return [...node.text, ...nested].join(" ").replaceAll(/\s+/g, " ").trim();
}

function parseAlter(node: XmlNode | undefined, context: string): number {
  const rawValue = nodeText(node);
  if (!rawValue) return 0;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || Math.abs(value) > 2) {
    parseError("malformed", `${context}의 임시표 값을 읽을 수 없어요.`);
  }
  return value;
}

function parsePitch(
  parent: XmlNode | undefined,
  stepName: "root-step" | "bass-step",
  alterName: "root-alter" | "bass-alter",
  context: string,
): MusicXmlPitch | null {
  if (!parent) return null;
  const step = nodeText(child(parent, stepName)).toUpperCase();
  const alter = parseAlter(child(parent, alterName), context);
  const label = musicXmlPitchLabel(step, alter);
  const noteName = musicXmlPitchToNoteName(step, alter);
  if (!label || !noteName) parseError("malformed", `${context}의 음 이름을 읽을 수 없어요.`);
  return { step, alter, label, noteName };
}

function parseHarmony(node: XmlNode, measureIndex: number, harmonyIndex: number): MusicXmlHarmony {
  const context = `${measureIndex + 1}번째 마디 코드`;
  const root = parsePitch(child(node, "root"), "root-step", "root-alter", `${context} 루트`);
  if (!root) parseError("malformed", `${context}에 루트 음이 없어요.`);

  const kindNode = child(node, "kind");
  if (!kindNode) parseError("malformed", `${context}에 코드 종류가 없어요.`);
  const kindValue = nodeText(kindNode).toLowerCase();
  const kindText = kindNode.attributes.text?.trim().slice(0, 48) ?? "";
  if (!kindValue) parseError("malformed", `${context}의 코드 종류를 읽을 수 없어요.`);
  const resolvedKind = resolveMusicXmlChordKind(kindValue, kindText);
  const bass = parsePitch(child(node, "bass"), "bass-step", "bass-alter", `${context} 베이스`);
  const symbol = formatMusicXmlChordSymbol({
    rootStep: root.step,
    rootAlter: root.alter,
    kindValue,
    kindText,
    bassStep: bass?.step,
    bassAlter: bass?.alter,
  });
  if (!symbol) parseError("malformed", `${context}의 코드 기호를 만들 수 없어요.`);
  const kindKey = resolvedKind?.patternName ?? `${kindValue}:${kindText}`;
  const uniqueKey = [root.step, root.alter, kindKey, bass?.step ?? "", bass?.alter ?? ""]
    .join(":");

  return {
    id: `m${measureIndex + 1}-h${harmonyIndex + 1}`,
    uniqueKey,
    measureIndex,
    root,
    kindValue,
    kindText,
    patternName: resolvedKind?.patternName ?? null,
    bass,
    symbol,
  };
}

function parseEnding(node: XmlNode): MusicXmlEnding | null {
  const type = node.attributes.type;
  if (type !== "start" && type !== "stop" && type !== "discontinue") return null;
  return {
    number: (node.attributes.number?.trim() || "?").slice(0, 24),
    type,
  };
}

function firstScoreAttribute(part: XmlNode, attributeName: "key" | "time"): XmlNode | undefined {
  for (const measure of children(part, "measure")) {
    const attributes = child(measure, "attributes");
    const result = child(attributes, attributeName);
    if (result) return result;
  }
  return undefined;
}

export function parseMusicXmlChordChart(input: string): MusicXmlChordChart {
  const source = input.replace(/^\uFEFF/, "");
  if (!source.trim()) parseError("empty", "비어 있는 파일이에요. MusicXML 코드표를 선택해 주세요.");
  if (utf8ByteLength(source) > MAX_MUSIC_XML_BYTES) {
    parseError("too-large", "MusicXML 파일은 2MB 이하만 열 수 있어요.");
  }
  if (source.includes("\0")) parseError("malformed", "XML 안에 읽을 수 없는 문자가 있어요.");

  const root = parseXmlTree(stripSafeStandardDoctype(source));
  if (root.name !== "score-partwise") {
    parseError("unsupported-score", "현재는 MusicXML의 score-partwise 코드표만 열 수 있어요.");
  }

  const part = children(root, "part")
    .map((candidate, index) => {
      const measures = children(candidate, "measure");
      const harmonyCount = measures.reduce(
        (count, measure) => count + children(measure, "harmony").length,
        0,
      );
      return { candidate, index, measureCount: measures.length, harmonyCount };
    })
    .filter(({ measureCount }) => measureCount > 0)
    .sort((left, right) =>
      right.harmonyCount - left.harmonyCount || left.index - right.index)[0]
    ?.candidate;
  if (!part) parseError("unsupported-score", "MusicXML에서 마디가 있는 파트를 찾지 못했어요.");
  const measureNodes = children(part, "measure");
  if (measureNodes.length > MAX_MUSIC_XML_MEASURES) {
    parseError("too-many-measures", "한 코드표에서 최대 512마디까지 열 수 있어요.");
  }

  let harmonyCount = 0;
  const harmonies: MusicXmlHarmony[] = [];
  const measures = measureNodes.map((measureNode, measureIndex): MusicXmlMeasure => {
    const harmonyNodes = children(measureNode, "harmony");
    harmonyCount += harmonyNodes.length;
    if (harmonyCount > MAX_MUSIC_XML_HARMONIES) {
      parseError("too-many-harmonies", "한 코드표에서 최대 2,048개의 코드까지 열 수 있어요.");
    }
    const measureHarmonies = harmonyNodes.map((harmonyNode, harmonyIndex) =>
      parseHarmony(harmonyNode, measureIndex, harmonyIndex));
    harmonies.push(...measureHarmonies);

    const barlines = children(measureNode, "barline");
    const repeats = barlines.flatMap((barline) => children(barline, "repeat"));
    const endings = barlines
      .flatMap((barline) => children(barline, "ending"))
      .map(parseEnding)
      .filter((ending): ending is MusicXmlEnding => ending !== null);
    const backwardsRepeat = repeats.find((repeat) => repeat.attributes.direction === "backward");
    const timesValue = backwardsRepeat?.attributes.times
      ? Number.parseInt(backwardsRepeat.attributes.times, 10)
      : Number.NaN;

    return {
      index: measureIndex,
      number: (measureNode.attributes.number?.trim() || String(measureIndex + 1)).slice(0, 24),
      harmonies: measureHarmonies,
      repeatStart: repeats.some((repeat) => repeat.attributes.direction === "forward"),
      repeatEnd: Boolean(backwardsRepeat),
      repeatTimes: Number.isInteger(timesValue) && timesValue >= 2 && timesValue <= 99 ? timesValue : null,
      endings,
      newSystem: child(measureNode, "print")?.attributes["new-system"] === "yes",
    };
  });

  const workTitle = nodeText(child(child(root, "work"), "work-title"));
  const movementTitle = nodeText(child(root, "movement-title"));
  const title = (workTitle || movementTitle || "제목 없는 코드표").slice(0, 200);

  const keyNode = firstScoreAttribute(part, "key");
  const rawFifths = nodeText(child(keyNode, "fifths"));
  const fifths = Number(rawFifths);
  const key = rawFifths && Number.isInteger(fifths) && fifths >= -12 && fifths <= 12
    ? { fifths, mode: nodeText(child(keyNode, "mode")).slice(0, 24) || null }
    : null;

  const timeNode = firstScoreAttribute(part, "time");
  const beats = nodeText(child(timeNode, "beats"));
  const beatType = nodeText(child(timeNode, "beat-type"));
  const time = /^[0-9+ ]{1,16}$/.test(beats) && /^(?:1|2|4|8|16|32|64)$/.test(beatType)
    ? { beats: beats.replaceAll(" ", ""), beatType }
    : null;

  return { title, key, time, measures, harmonies };
}
