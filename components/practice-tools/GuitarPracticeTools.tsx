"use client";

import { Guitar, MoveHorizontal } from "lucide-react";
import { useState } from "react";

import {
  CHORD_LABELS,
  CHORD_PATTERNS,
  NOTES_SHARP,
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

import styles from "./GuitarPracticeTools.module.css";

const SCALE_OPTIONS = Object.keys(SCALE_PATTERNS) as (keyof typeof SCALE_PATTERNS)[];
const CHORD_OPTIONS = Object.keys(CHORD_PATTERNS) as (keyof typeof CHORD_PATTERNS)[];
const FRET_POSITION_WINDOWS = getFretPositionWindows();

function range(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function GuitarPracticeTools() {
  const [rootNote, setRootNote] = useState<NoteName>("C");
  const [kind, setKind] = useState<PatternKind>("scale");
  const [patternName, setPatternName] = useState("Major");
  const [positionId, setPositionId] = useState("full");
  const [capoFret, setCapoFret] = useState(0);
  const [capoTarget, setCapoTarget] = useState<NoteName>("C");
  const [capoQuality, setCapoQuality] = useState<ChordQuality>("major");

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

  function chooseKind(nextKind: PatternKind) {
    setKind(nextKind);
    setPatternName("Major");
  }

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>
          <Guitar size={14} aria-hidden="true" /> 기존 기타 도구에서 옮겨온 연습 기능
        </p>
        <h1>기타 연습 도구</h1>
        <p>스케일과 코드 위치를 확인하고, 프렛 구간과 카포 운지를 바로 비교하세요.</p>
      </header>

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
              {NOTES_SHARP.map((note) => <option key={note} value={note}>{note}</option>)}
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
                {NOTES_SHARP.map((note) => <option key={note} value={note}>{note}</option>)}
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
