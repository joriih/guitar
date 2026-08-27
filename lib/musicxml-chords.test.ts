import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { MAX_MUSIC_XML_BYTES, MusicXmlParseError, parseMusicXmlChordChart } from "./musicxml-chords.ts";

const STANDARD_DOCTYPE = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';

const SYNTHETIC_CHART = `<?xml version="1.0" encoding="UTF-8"?>
${STANDARD_DOCTYPE}
<score-partwise version="3.1">
  <work><work-title>작은 &amp; 안전한 코드표</work-title></work>
  <part-list><score-part id="P1"><part-name>Lead sheet</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <print new-system="yes"/>
      <attributes>
        <key><fifths>-2</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <barline location="left">
        <repeat direction="forward"/>
        <ending number="1" type="start"/>
      </barline>
      <harmony>
        <root><root-step>B</root-step><root-alter>-1</root-alter></root>
        <kind text="maj7">major-seventh</kind>
      </harmony>
    </measure>
    <measure number="2">
      <harmony>
        <root><root-step>G</root-step></root>
        <kind text="m7">minor-seventh</kind>
        <bass><bass-step>B</bass-step><bass-alter>-1</bass-alter></bass>
      </harmony>
      <barline location="right">
        <ending number="1" type="stop"/>
        <repeat direction="backward" times="3"/>
      </barline>
    </measure>
  </part>
</score-partwise>`;

test("parses a bounded chord chart without resolving the standard MusicXML DTD", () => {
  const chart = parseMusicXmlChordChart(SYNTHETIC_CHART);
  assert.equal(chart.title, "작은 & 안전한 코드표");
  assert.deepEqual(chart.key, { fifths: -2, mode: "major" });
  assert.deepEqual(chart.time, { beats: "4", beatType: "4" });
  assert.equal(chart.measures.length, 2);
  assert.equal(chart.harmonies.length, 2);
  assert.equal(chart.harmonies[0].symbol, "B♭maj7");
  assert.equal(chart.harmonies[0].root.noteName, "Bb");
  assert.equal(chart.harmonies[0].patternName, "Major 7th");
  assert.equal(chart.harmonies[1].symbol, "Gm7/B♭");
  assert.equal(chart.measures[0].repeatStart, true);
  assert.equal(chart.measures[0].newSystem, true);
  assert.deepEqual(chart.measures[0].endings, [{ number: "1", type: "start" }]);
  assert.equal(chart.measures[1].repeatEnd, true);
  assert.equal(chart.measures[1].repeatTimes, 3);
});

test("rejects external entities, nonstandard doctypes, and malformed nesting", () => {
  for (const source of [
    '<!DOCTYPE score-partwise SYSTEM "https://example.com/evil.dtd"><score-partwise/>',
    '<!DOCTYPE score-partwise [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><score-partwise>&xxe;</score-partwise>',
  ]) {
    assert.throws(
      () => parseMusicXmlChordChart(source),
      (error) => error instanceof MusicXmlParseError && error.code === "unsafe-xml",
    );
  }
  assert.throws(
    () => parseMusicXmlChordChart("<score-partwise><part></score-partwise>"),
    (error) => error instanceof MusicXmlParseError && error.code === "malformed",
  );
});

test("enforces byte, measure, and harmony limits before rendering", () => {
  assert.throws(
    () => parseMusicXmlChordChart(`<score-partwise>${" ".repeat(MAX_MUSIC_XML_BYTES)}</score-partwise>`),
    (error) => error instanceof MusicXmlParseError && error.code === "too-large",
  );

  const measures = Array.from({ length: 513 }, (_, index) => `<measure number="${index + 1}"/>`).join("");
  assert.throws(
    () => parseMusicXmlChordChart(`<score-partwise><part>${measures}</part></score-partwise>`),
    (error) => error instanceof MusicXmlParseError && error.code === "too-many-measures",
  );

  const harmonies = Array.from({ length: 2_049 }, () => (
    "<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>"
  )).join("");
  assert.throws(
    () => parseMusicXmlChordChart(`<score-partwise><part><measure>${harmonies}</measure></part></score-partwise>`),
    (error) => error instanceof MusicXmlParseError && error.code === "too-many-harmonies",
  );
});

test("returns friendly errors for empty or unsupported scores", () => {
  assert.throws(
    () => parseMusicXmlChordChart("   "),
    (error) => error instanceof MusicXmlParseError
      && error.code === "empty"
      && error.message.includes("비어 있는 파일"),
  );
  assert.throws(
    () => parseMusicXmlChordChart("<score-timewise/>"),
    (error) => error instanceof MusicXmlParseError
      && error.code === "unsupported-score"
      && error.message.includes("score-partwise"),
  );
});
