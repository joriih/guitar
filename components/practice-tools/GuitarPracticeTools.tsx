"use client";

import { FileMusic, Guitar, MoveHorizontal, Upload, X } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  CHORD_LABELS,
  CHORD_PATTERNS,
  SCALE_LABELS,
  SCALE_PATTERNS,
  STANDARD_GUITAR_STRINGS,
  getCapoMappings,
  getFretPositionWindows,
  getMatchingCapoShapes,
  getNoteIndex,
  getPatternDegreeName,
  getPatternIntervals,
  getPatternNotes,
  noteName,
  preferredAccidental,
  type ChordQuality,
  type NoteName,
  type PatternKind,
} from "@/lib/music-theory";
import {
  MAX_MUSIC_XML_BYTES,
  MusicXmlParseError,
  parseMusicXmlChordChart,
  type MusicXmlChordChart,
  type MusicXmlHarmony,
} from "@/lib/musicxml-chords";
import { getArpeggioReferenceFileName } from "@/lib/arpeggio-reference";

import styles from "./GuitarPracticeTools.module.css";

const SCALE_OPTIONS = Object.keys(SCALE_PATTERNS) as (keyof typeof SCALE_PATTERNS)[];
const CHORD_OPTIONS = Object.keys(CHORD_PATTERNS) as (keyof typeof CHORD_PATTERNS)[];
const FRET_POSITION_WINDOWS = getFretPositionWindows();
const ROOT_OPTIONS: readonly NoteName[] = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B",
];
const MINI_FRETS = [0, 1, 2, 3, 4] as const;

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function dedupeHarmonies(harmonies: MusicXmlHarmony[]): MusicXmlHarmony[] {
  return [...new Map(harmonies.map((harmony) => [harmony.uniqueKey, harmony])).values()];
}

function keyName(fifths: number): string {
  const keys: Readonly<Record<number, string>> = {
    [-7]: "C♭", [-6]: "G♭", [-5]: "D♭", [-4]: "A♭", [-3]: "E♭", [-2]: "B♭", [-1]: "F",
    0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F♯", 7: "C♯",
  };
  return keys[fifths] ?? `5도 ${fifths > 0 ? `+${fifths}` : fifths}`;
}

function modeLabel(mode: string | null): string {
  if (mode === "major") return "메이저";
  if (mode === "minor") return "마이너";
  return mode ?? "";
}

function harmonyPreference(harmony: MusicXmlHarmony): "sharp" | "flat" {
  if (harmony.root.alter < 0) return "flat";
  if (harmony.root.alter > 0) return "sharp";
  return preferredAccidental(harmony.root.noteName);
}

function MiniFretboard({ harmony }: { harmony: MusicXmlHarmony }) {
  if (!harmony.patternName) {
    return <span className={styles.unknownChord}>이 코드 종류는 구성음 자동 분석을 준비 중이에요.</span>;
  }

  const intervals = new Set(getPatternIntervals("chord", harmony.patternName));
  const rootIndex = getNoteIndex(harmony.root.noteName) ?? 0;
  return (
    <span
      className={styles.miniFretboard}
      role="img"
      aria-label={`${harmony.symbol} 코드의 0프렛부터 4프렛까지 구성음 위치`}
    >
      {[...STANDARD_GUITAR_STRINGS].reverse().map((string) => (
        <span className={styles.miniString} key={string.label}>
          {MINI_FRETS.map((fret) => {
            const interval = (string.pitchClass + fret - rootIndex + 24) % 12;
            const active = intervals.has(interval);
            return (
              <span className={styles.miniFret} key={fret}>
                {active ? (
                  <i className={interval === 0 ? styles.miniRoot : undefined} />
                ) : null}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

function PersonalReferenceFretboard({ harmony }: { harmony: MusicXmlHarmony }) {
  const fileName = getArpeggioReferenceFileName(harmony.root.noteName, harmony.patternName);
  const [failedFileName, setFailedFileName] = useState<string | null>(null);
  if (!fileName || failedFileName === fileName) return null;

  return (
    <span className={styles.referenceFretboard}>
      {/* The source library is private local data, so a regular authenticated
          request is required instead of Next/Image's public optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/practice-reference/arpeggios/${encodeURIComponent(fileName)}`}
        alt={`${harmony.symbol} 아르페지오 전체 지판 참고 이미지`}
        decoding="async"
        draggable={false}
        onError={() => setFailedFileName(fileName)}
      />
      <small>개인 참고 · guitar-chords.org.uk</small>
    </span>
  );
}

export function GuitarPracticeTools() {
  const [rootNote, setRootNote] = useState<NoteName>("C");
  const [kind, setKind] = useState<PatternKind>("scale");
  const [patternName, setPatternName] = useState("Major");
  const [positionId, setPositionId] = useState("full");
  const [capoFret, setCapoFret] = useState(0);
  const [capoTarget, setCapoTarget] = useState<NoteName>("C");
  const [capoQuality, setCapoQuality] = useState<ChordQuality>("major");
  const [chart, setChart] = useState<MusicXmlChordChart | null>(null);
  const [chartFileName, setChartFileName] = useState("");
  const [chartError, setChartError] = useState("");
  const [selectedHarmonyKey, setSelectedHarmonyKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const positionWindows = FRET_POSITION_WINDOWS;
  const selectedPosition = positionId === "full"
    ? null
    : positionWindows[Number(positionId)] ?? null;
  const startFret = selectedPosition?.startFret ?? 0;
  const endFret = selectedPosition?.endFret ?? 12;
  const frets = range(startFret, endFret);
  const intervals = getPatternIntervals(kind, patternName);
  const activeIntervals = new Set(intervals);
  const rootIndex = getNoteIndex(rootNote) ?? 0;
  const accidental = preferredAccidental(rootNote);
  const patternNotes = getPatternNotes(rootNote, kind, patternName);
  const patternOptions: readonly string[] = kind === "scale" ? SCALE_OPTIONS : CHORD_OPTIONS;
  const patternLabels: Readonly<Record<string, string>> = kind === "scale"
    ? SCALE_LABELS
    : CHORD_LABELS;

  const capoMappings = getCapoMappings(capoFret, preferredAccidental(capoTarget));
  const matchingShapes = getMatchingCapoShapes(capoTarget, capoQuality, capoFret);
  const targetChordName = `${capoTarget}${capoQuality === "minor" ? "m" : ""}`;
  const uniqueHarmonies = useMemo(
    () => dedupeHarmonies(chart?.harmonies ?? []),
    [chart],
  );

  function chooseKind(nextKind: PatternKind) {
    setKind(nextKind);
    setPatternName("Major");
  }

  function chooseHarmony(harmony: MusicXmlHarmony) {
    setSelectedHarmonyKey(harmony.uniqueKey);
    if (!harmony.patternName) return;
    setRootNote(harmony.root.noteName);
    setKind("chord");
    setPatternName(harmony.patternName);
    setPositionId("full");
  }

  async function openMusicXml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setChartError("");

    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".musicxml") && !lowerName.endsWith(".xml")) {
      setChartError(".musicxml 또는 .xml 형식의 코드표를 선택해 주세요.");
      return;
    }
    if (file.size > MAX_MUSIC_XML_BYTES) {
      setChartError("MusicXML 파일은 2MB 이하만 열 수 있어요.");
      return;
    }

    try {
      const nextChart = parseMusicXmlChordChart(await file.text());
      setChart(nextChart);
      setChartFileName(file.name);
      const firstHarmony = nextChart.harmonies.find((harmony) => harmony.patternName)
        ?? nextChart.harmonies[0];
      if (firstHarmony) chooseHarmony(firstHarmony);
      else setSelectedHarmonyKey(null);
    } catch (error) {
      setChartError(
        error instanceof MusicXmlParseError
          ? error.message
          : "코드표를 읽지 못했어요. MusicXML 파일인지 확인해 주세요.",
      );
    }
  }

  function closeChart() {
    setChart(null);
    setChartFileName("");
    setChartError("");
    setSelectedHarmonyKey(null);
  }

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>
          <Guitar size={14} aria-hidden="true" /> 혼자서도 오래 쓰는 기타 공부 공간
        </p>
        <h1>코드표에서 프렛보드까지</h1>
        <p>iReal Pro 같은 MusicXML 코드표를 열고, 곡의 모든 코드와 구성음을 한 화면에서 연습하세요.</p>
      </header>

      <section className={`${styles.section} ${styles.chartSection}`} aria-labelledby="chart-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="chart-title">내 코드표 열기</h2>
            <p>MusicXML을 고르면 마디, 코드톤, 프렛 위치를 함께 보여줍니다.</p>
          </div>
          <span className={styles.localOnly}>로컬에서만 읽음</span>
        </div>

        <div className={styles.uploadRow}>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept=".musicxml,.xml,application/vnd.recordare.musicxml+xml,application/xml,text/xml"
            onChange={openMusicXml}
            aria-describedby="musicxml-privacy"
          />
          <button
            className={styles.uploadButton}
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} aria-hidden="true" />
            {chart ? "다른 코드표 열기" : "MusicXML 코드표 열기"}
          </button>
          <p id="musicxml-privacy">
            이 Mac 안에서만 분석하며 서버에 올리거나 라이브러리에 저장하지 않습니다. 최대 2MB.
          </p>
        </div>

        {chartError ? <p className={styles.uploadError} role="alert">{chartError}</p> : null}

        {!chart ? (
          <div className={styles.chartEmpty}>
            <FileMusic size={22} aria-hidden="true" />
            <div>
              <strong>iReal Pro에서 내보낸 MusicXML도 열 수 있어요.</strong>
              <p>파일을 선택하면 코드표와 코드별 구성음 다이어그램이 이 자리에 나타납니다.</p>
            </div>
          </div>
        ) : (
          <div className={styles.chartResult}>
            <div className={styles.chartIdentity}>
              <div>
                <span className={styles.fileName}>{chartFileName}</span>
                <h3>{chart.title}</h3>
              </div>
              <div className={styles.chartMeta} aria-label="코드표 정보">
                {chart.key ? (
                  <span>{keyName(chart.key.fifths)} {modeLabel(chart.key.mode)}</span>
                ) : null}
                {chart.time ? <span>{chart.time.beats}/{chart.time.beatType}</span> : null}
                <span>{chart.measures.length}마디</span>
                <span>{uniqueHarmonies.length}개 코드</span>
              </div>
              <button className={styles.closeChart} type="button" onClick={closeChart} aria-label="코드표 닫기">
                <X size={17} aria-hidden="true" />
              </button>
            </div>

            <div className={styles.chartWorkspace}>
              <div className={styles.measurePanel}>
                <div className={styles.panelHeading}>
                  <strong>코드 진행</strong>
                  <span>코드를 누르면 프렛보드가 바뀝니다</span>
                </div>
                <div className={styles.measureGrid}>
                  {chart.measures.map((measure) => {
                    const selected = measure.harmonies.some(
                      (harmony) => harmony.uniqueKey === selectedHarmonyKey,
                    );
                    return (
                      <div
                        className={`${styles.measure} ${selected ? styles.selectedMeasure : ""} ${measure.newSystem ? styles.newSystemMeasure : ""}`}
                        key={`${measure.index}-${measure.number}`}
                      >
                        <div className={styles.measureTopline}>
                          <span>{measure.number}</span>
                          <span className={styles.measureMarks}>
                            {measure.endings.map((ending, index) => (
                              <i key={`${ending.number}-${ending.type}-${index}`}>{ending.number}.</i>
                            ))}
                            {measure.repeatTimes ? <i>{measure.repeatTimes}×</i> : null}
                          </span>
                        </div>
                        <div className={styles.measureChords}>
                          {measure.repeatStart ? <b aria-label="도돌이표 시작">|:</b> : null}
                          {measure.harmonies.length ? measure.harmonies.map((harmony) => (
                            <button
                              key={harmony.id}
                              type="button"
                              aria-pressed={harmony.uniqueKey === selectedHarmonyKey}
                              onClick={() => chooseHarmony(harmony)}
                            >
                              {harmony.symbol}
                            </button>
                          )) : <span aria-label="코드 없음">—</span>}
                          {measure.repeatEnd ? <b aria-label="도돌이표 끝">:|</b> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <aside className={styles.tonePanel} aria-label="코드별 구성음">
                <div className={styles.panelHeading}>
                  <strong>코드톤</strong>
                  <span>같은 코드는 한 번만 정리했어요</span>
                </div>
                {uniqueHarmonies.length ? (
                  <div className={styles.toneCards}>
                    {uniqueHarmonies.map((harmony) => {
                      const chordIntervals = harmony.patternName
                        ? getPatternIntervals("chord", harmony.patternName)
                        : [];
                      const chordNotes = harmony.patternName
                        ? getPatternNotes(
                            harmony.root.noteName,
                            "chord",
                            harmony.patternName,
                            harmonyPreference(harmony),
                          )
                        : [];
                      const occurrenceCount = chart.harmonies.filter(
                        (candidate) => candidate.uniqueKey === harmony.uniqueKey,
                      ).length;
                      return (
                        <button
                          className={styles.toneCard}
                          key={harmony.uniqueKey}
                          type="button"
                          aria-pressed={harmony.uniqueKey === selectedHarmonyKey}
                          onClick={() => chooseHarmony(harmony)}
                        >
                          <span className={styles.toneCardHeading}>
                            <strong>{harmony.symbol}</strong>
                            <small>{occurrenceCount}회</small>
                          </span>
                          {harmony.patternName ? (
                            <>
                              <span className={styles.toneNotes}>{chordNotes.join(" · ")}</span>
                              <span className={styles.toneDegrees}>
                                {chordIntervals.map((interval) =>
                                  getPatternDegreeName("chord", harmony.patternName ?? "", interval)).join("  ")}
                              </span>
                            </>
                          ) : null}
                          <MiniFretboard harmony={harmony} />
                          <PersonalReferenceFretboard harmony={harmony} />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className={styles.noHarmony}>이 악보에는 표시할 코드 기호가 없어요.</p>
                )}
              </aside>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="fretboard-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="fretboard-title">프렛보드</h2>
            <p>루트 음은 진하게, 나머지 구성음은 테두리로 표시합니다.</p>
          </div>
          <span className={styles.scrollHint}>
            <MoveHorizontal size={15} aria-hidden="true" /> 좌우로 확인
          </span>
        </div>

        <div className={styles.controls}>
          <div className={styles.field}>
            <label htmlFor="practice-root-note">루트</label>
            <select
              id="practice-root-note"
              value={rootNote}
              onChange={(event) => {
                setRootNote(event.target.value as NoteName);
                setPositionId("full");
              }}
            >
              {ROOT_OPTIONS.map((note) => <option key={note} value={note}>{note}</option>)}
            </select>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>종류</span>
            <div className={styles.segmented} role="group" aria-label="표시 종류">
              <button
                type="button"
                aria-pressed={kind === "scale"}
                onClick={() => chooseKind("scale")}
              >
                스케일
              </button>
              <button
                type="button"
                aria-pressed={kind === "chord"}
                onClick={() => chooseKind("chord")}
              >
                코드
              </button>
            </div>
          </div>

          <div className={`${styles.field} ${styles.patternField}`}>
            <label htmlFor="practice-pattern">패턴</label>
            <select
              id="practice-pattern"
              value={patternName}
              onChange={(event) => setPatternName(event.target.value)}
            >
              {patternOptions.map((option) => (
                <option key={option} value={option}>{patternLabels[option]}</option>
              ))}
            </select>
          </div>

          <div className={`${styles.field} ${styles.positionField}`}>
            <label htmlFor="practice-position">표시 구간</label>
            <select
              id="practice-position"
              value={positionId}
              onChange={(event) => setPositionId(event.target.value)}
            >
              <option value="full">0–12프렛 전체</option>
              {positionWindows.map((position, index) => (
                <option key={position.startFret} value={String(index)}>
                  {position.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.noteSummary} aria-live="polite">
          <strong>{rootNote} {patternLabels[patternName] ?? patternName}</strong>
          <span>{patternNotes.join(" · ")}</span>
        </div>

        <div className={styles.fretboardScroller} tabIndex={0} aria-label="프렛보드 가로 스크롤 영역">
          <table className={styles.fretboard}>
            <caption className="sr-only">
              {rootNote} {patternName}의 {startFret}프렛부터 {endFret}프렛까지 구성음
            </caption>
            <thead>
              <tr>
                <th scope="col">현</th>
                {frets.map((fret) => <th scope="col" key={fret}>{fret === 0 ? "개방" : fret}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...STANDARD_GUITAR_STRINGS].reverse().map((string) => (
                <tr key={string.label}>
                  <th scope="row">{string.label}</th>
                  {frets.map((fret) => {
                    const pitchClass = (string.pitchClass + fret) % 12;
                    const interval = (pitchClass - rootIndex + 12) % 12;
                    const active = activeIntervals.has(interval);
                    const displayedNote = noteName(pitchClass, accidental);
                    const displayedDegree = getPatternDegreeName(kind, patternName, interval);
                    return (
                      <td key={fret} aria-label={`${string.label} ${fret}프렛 ${displayedNote}`}>
                        {active ? (
                          <span
                            className={`${styles.noteDot} ${interval === 0 ? styles.rootNote : ""}`}
                            title={`${displayedNote} · ${displayedDegree}`}
                          >
                            <b>{displayedNote}</b>
                            <small>{displayedDegree}</small>
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.legend} aria-label="프렛보드 범례">
          <span><i className={styles.rootLegend} /> 루트</span>
          <span><i className={styles.noteLegend} /> 구성음</span>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="capo-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="capo-title">카포 계산기</h2>
            <p>카포 위치에서 원하는 키가 나는 열린 코드 폼을 찾습니다.</p>
          </div>
        </div>

        <div className={styles.capoLayout}>
          <div className={styles.capoControls}>
            <div className={styles.field}>
              <label htmlFor="capo-target">원하는 키</label>
              <select
                id="capo-target"
                value={capoTarget}
                onChange={(event) => setCapoTarget(event.target.value as NoteName)}
              >
                {ROOT_OPTIONS.map((note) => <option key={note} value={note}>{note}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="capo-quality">코드 성격</label>
              <select
                id="capo-quality"
                value={capoQuality}
                onChange={(event) => setCapoQuality(event.target.value as ChordQuality)}
              >
                <option value="major">메이저</option>
                <option value="minor">마이너</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="capo-fret">카포 위치</label>
              <select
                id="capo-fret"
                value={capoFret}
                onChange={(event) => setCapoFret(Number(event.target.value))}
              >
                {range(0, 12).map((fret) => (
                  <option key={fret} value={fret}>{fret === 0 ? "카포 없음" : `${fret}프렛`}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.capoResult} aria-live="polite">
            <span className={styles.resultLabel}>추천 운지</span>
            {matchingShapes.length ? (
              <strong>{matchingShapes.map(({ shape }) => shape).join(" · ")}</strong>
            ) : (
              <strong>이 위치에는 기본 열린 코드 폼이 없습니다.</strong>
            )}
            <p>
              {matchingShapes.length === 0
                ? `${targetChordName} 코드를 낼 수 있는 기본 열린 코드 폼이 없습니다.`
                : capoFret === 0
                  ? `카포 없이 ${targetChordName} 코드와 같은 폼을 사용합니다.`
                  : `카포 ${capoFret}프렛 기준으로 ${targetChordName} 코드가 나는 폼입니다.`}
            </p>
          </div>
        </div>

        <ul className={styles.capoMap} aria-label={`카포 ${capoFret}프렛 전체 변환`}>
          {capoMappings.map(({ shape, soundingNote, quality }) => (
            <li key={shape}>
              <span>{shape}</span>
              <strong>
                {soundingNote}
                {quality === "minor" ? "m" : ""}
              </strong>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
