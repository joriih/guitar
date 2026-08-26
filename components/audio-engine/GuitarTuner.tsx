"use client";

import { Mic, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { clamp, createAudioContext } from "./browser";
import styles from "./GuitarTuner.module.css";
import {
  closestStandardGuitarString,
  detectPitchAutocorrelation,
  frequencyToPitch,
  type GuitarStringMatch,
  type PitchDetection,
} from "./tuner-detection";

export type TunerStatus = "idle" | "requesting" | "listening" | "no-signal" | "error";

export type UseGuitarTunerOptions = {
  active?: boolean;
  stream?: MediaStream | null;
  minFrequency?: number;
  maxFrequency?: number;
  fftSize?: 2048 | 4096 | 8192;
};

export type GuitarTunerState = {
  status: TunerStatus;
  pitch: PitchDetection | null;
  guitarString: GuitarStringMatch | null;
  error: string | null;
};

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "마이크 권한이 필요해요. 브라우저 설정에서 허용해주세요.";
    }
    if (error.name === "NotFoundError") return "사용할 수 있는 마이크를 찾지 못했어요.";
    if (error.name === "NotReadableError") return "다른 앱이 마이크를 사용하고 있어요.";
  }
  return error instanceof Error ? error.message : "튜너를 시작하지 못했어요.";
}

export function useGuitarTuner(options: UseGuitarTunerOptions = {}): GuitarTunerState {
  const {
    active = false,
    stream: suppliedStream = null,
    minFrequency = 65,
    maxFrequency = 1_200,
    fftSize = 4096,
  } = options;
  const [state, setState] = useState<GuitarTunerState>({
    status: "idle",
    pitch: null,
    guitarString: null,
    error: null,
  });

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let animationFrame = 0;
    let context: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let ownedStream: MediaStream | null = null;
    let lastAnalysisTime = 0;
    let silentFrames = 0;
    let smoothedFrequency: number | null = null;
    let pendingJumpMidi: number | null = null;
    let pendingJumpFrames = 0;
    let inputTrack: MediaStreamTrack | null = null;

    const releaseAudio = () => {
      window.cancelAnimationFrame(animationFrame);
      sourceNode?.disconnect();
      analyser?.disconnect();
      inputTrack?.removeEventListener("ended", handleTrackEnded);
      ownedStream?.getTracks().forEach((track) => track.stop());
      const activeContext = context;
      context = null;
      sourceNode = null;
      analyser = null;
      inputTrack = null;
      ownedStream = null;
      if (activeContext && activeContext.state !== "closed") {
        void activeContext.close().catch(() => undefined);
      }
    };

    function handleTrackEnded() {
      if (cancelled) return;
      cancelled = true;
      releaseAudio();
      setState({
        status: "error",
        pitch: null,
        guitarString: null,
        error: "오디오 입력 연결이 끊겼어요. 튜너를 껐다가 다시 켜주세요.",
      });
    }

    window.queueMicrotask(() => {
      if (!cancelled) {
        setState({ status: "requesting", pitch: null, guitarString: null, error: null });
      }
    });

    async function start() {
      try {
        const mediaStream = suppliedStream ?? (await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
        }));
        if (!suppliedStream) ownedStream = mediaStream;
        if (cancelled) {
          ownedStream?.getTracks().forEach((track) => track.stop());
          return;
        }
        inputTrack = mediaStream.getAudioTracks()[0] ?? null;
        if (!inputTrack || inputTrack.readyState !== "live") throw new Error("오디오 입력이 없어요.");
        inputTrack.addEventListener("ended", handleTrackEnded);

        context = createAudioContext({ latencyHint: "interactive" });
        if (context.state === "suspended") await context.resume();
        sourceNode = context.createMediaStreamSource(mediaStream);
        analyser = context.createAnalyser();
        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0;
        sourceNode.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        setState({ status: "listening", pitch: null, guitarString: null, error: null });

        const analyse = (timestamp: number) => {
          if (cancelled || !analyser || !context) return;
          animationFrame = window.requestAnimationFrame(analyse);
          if (timestamp - lastAnalysisTime < 70) return;
          lastAnalysisTime = timestamp;
          analyser.getFloatTimeDomainData(samples);
          const pitch = detectPitchAutocorrelation(samples, context.sampleRate, {
            minFrequency,
            maxFrequency,
          });
          if (!pitch) {
            silentFrames += 1;
            if (silentFrames >= 4) {
              smoothedFrequency = null;
              pendingJumpMidi = null;
              pendingJumpFrames = 0;
              setState({ status: "no-signal", pitch: null, guitarString: null, error: null });
            }
            return;
          }
          silentFrames = 0;
          if (smoothedFrequency !== null) {
            const semitoneJump = 12 * Math.log2(pitch.frequency / smoothedFrequency);
            if (Math.abs(semitoneJump) > 1.5) {
              if (pendingJumpMidi === pitch.midi) pendingJumpFrames += 1;
              else {
                pendingJumpMidi = pitch.midi;
                pendingJumpFrames = 1;
              }
              // Ignore one-frame octave/harmonic spikes common at pick attack.
              if (pendingJumpFrames < 2) return;
              smoothedFrequency = pitch.frequency;
            } else {
              pendingJumpMidi = null;
              pendingJumpFrames = 0;
              const alpha = 0.32;
              smoothedFrequency = 2 ** (
                Math.log2(smoothedFrequency) * (1 - alpha) + Math.log2(pitch.frequency) * alpha
              );
            }
          } else {
            smoothedFrequency = pitch.frequency;
          }
          const stablePitch = frequencyToPitch(smoothedFrequency, pitch.confidence);
          if (!stablePitch) return;
          setState({
            status: "listening",
            pitch: stablePitch,
            guitarString: closestStandardGuitarString(stablePitch.frequency),
            error: null,
          });
        };
        animationFrame = window.requestAnimationFrame(analyse);
      } catch (error) {
        if (!cancelled) {
          cancelled = true;
          releaseAudio();
          setState({ status: "error", pitch: null, guitarString: null, error: microphoneError(error) });
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      releaseAudio();
    };
  }, [active, fftSize, maxFrequency, minFrequency, suppliedStream]);

  return active
    ? state
    : { status: "idle", pitch: null, guitarString: null, error: null };
}

export type GuitarTunerProps = {
  stream?: MediaStream | null;
  defaultActive?: boolean;
  className?: string;
};

function tunerHint(state: GuitarTunerState): string {
  if (state.status === "requesting") return "마이크를 준비하고 있어요…";
  if (state.status === "no-signal") return "한 줄씩 또렷하게 튕겨주세요.";
  if (state.status === "error") return state.error ?? "튜너를 시작하지 못했어요.";
  if (!state.pitch) return "튜너를 켜고 기타 줄을 튕겨주세요.";
  if (Math.abs(state.pitch.cents) <= 5) return "음정이 정확해요.";
  return state.pitch.cents < 0 ? "조금 더 높여주세요." : "조금 더 낮춰주세요.";
}

export function GuitarTuner({ stream, defaultActive = false, className }: GuitarTunerProps) {
  const titleId = useId();
  const [active, setActive] = useState(defaultActive);
  const state = useGuitarTuner({ active, stream });
  const cents = clamp(state.pitch?.cents ?? 0, -50, 50);
  const isTuned = state.pitch ? Math.abs(state.pitch.cents) <= 5 : false;
  const hint = tunerHint(state);
  const desiredLiveSummary = useMemo(() => {
    if (!state.pitch) return hint;
    const direction = isTuned ? "정확" : state.pitch.cents < 0 ? "낮음" : "높음";
    return `${state.pitch.note}${state.pitch.octave}, ${direction}`;
  }, [hint, isTuned, state.pitch]);
  const [liveSummary, setLiveSummary] = useState(desiredLiveSummary);
  useEffect(() => {
    if (desiredLiveSummary === liveSummary) return;
    const timer = window.setTimeout(() => setLiveSummary(desiredLiveSummary), 900);
    return () => window.clearTimeout(timer);
  }, [desiredLiveSummary, liveSummary]);
  const toggle = useCallback(() => setActive((value) => !value), []);

  return (
    <section className={`${styles.tuner} ${className ?? ""}`} aria-labelledby={titleId}>
      <div className={styles.header}>
        <div>
          <h2 id={titleId}>기타 튜너</h2>
          <p>표준 튜닝 · A 440Hz</p>
        </div>
        <button type="button" onClick={toggle} aria-pressed={active}>
          {active ? <Square size={14} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
          {active ? "끄기" : "튜너 켜기"}
        </button>
      </div>

      <div className={styles.readout} data-tuned={isTuned || undefined}>
        <span className={styles.stringName}>
          {state.guitarString && Math.abs(state.guitarString.cents) <= 100
            ? state.guitarString.name
            : "감지 음"}
        </span>
        <strong>{state.pitch ? `${state.pitch.note}${state.pitch.octave}` : "–"}</strong>
        <span className={styles.frequency}>
          {state.pitch ? `${state.pitch.frequency.toFixed(1)} Hz` : "마이크 대기"}
        </span>
      </div>

      <div className={styles.meter} aria-hidden="true">
        <span className={styles.flat}>♭</span>
        <div className={styles.scale}>
          {[-50, -25, 0, 25, 50].map((tick) => (
            <i key={tick} className={tick === 0 ? styles.centerTick : undefined} />
          ))}
          <span
            className={styles.needle}
            data-tuned={isTuned || undefined}
            style={{ left: `${cents + 50}%` }}
          />
        </div>
        <span className={styles.sharp}>♯</span>
      </div>

      <p className={styles.hint} data-error={state.status === "error" || undefined}>
        {hint}
      </p>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveSummary}
      </span>
    </section>
  );
}
