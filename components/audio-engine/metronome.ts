import { clamp, nonNegative } from "./browser";

export type MetronomeBeat = {
  index: number;
  beatInBar: number;
  bar: number;
  isAccent: boolean;
  isCountIn: boolean;
  audioTime: number;
};

export type MetronomeOptions = {
  bpm: number;
  beatsPerBar?: number;
  subdivision?: 1 | 2 | 4;
  countInBars?: number;
  startTime?: number;
  durationSeconds?: number;
  volume?: number;
  onBeat?: (beat: MetronomeBeat) => void;
};

export type CountInOptions = Omit<MetronomeOptions, "countInBars" | "durationSeconds"> & {
  bars?: number;
};

export type CountInSchedule = {
  recordingStartTime: number;
  beats: readonly MetronomeBeat[];
  wait: (signal?: AbortSignal) => Promise<void>;
  cancel: () => void;
};

type ClickNodes = {
  oscillator: OscillatorNode;
  gain: GainNode;
};

function validBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error("BPM은 0보다 커야 해요.");
  return clamp(bpm, 20, 400);
}

function validBeatsPerBar(beatsPerBar: number | undefined): number {
  const value = beatsPerBar ?? 4;
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error("한 마디의 박자 수를 확인해주세요.");
  }
  return value;
}

function validSubdivision(subdivision: number | undefined): 1 | 2 | 4 {
  const value = subdivision ?? 1;
  if (value !== 1 && value !== 2 && value !== 4) {
    throw new Error("메트로놈 세분음은 1, 2, 4 중에서 선택해주세요.");
  }
  return value;
}

function audioStartTime(
  context: BaseAudioContext,
  requested: number | undefined,
  defaultLeadSeconds = 0.05,
): number {
  const fallback = context.currentTime + defaultLeadSeconds;
  const candidate = typeof requested === "number" && Number.isFinite(requested)
    ? requested
    : fallback;
  return Math.max(context.currentTime + 0.025, candidate);
}

/** Keeps callbacks aligned if the AudioContext is temporarily suspended. */
function scheduleAtAudioTime(
  context: BaseAudioContext,
  targetTime: number,
  callback: () => void,
): () => void {
  let timer: number | null = null;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    if (context.state === "closed") {
      cancelled = true;
      return;
    }
    const remainingMs = (targetTime - context.currentTime) * 1_000;
    if (remainingMs <= 1) {
      cancelled = true;
      callback();
      return;
    }
    timer = window.setTimeout(check, Math.min(100, Math.max(1, remainingMs)));
  };
  check();
  return () => {
    cancelled = true;
    if (timer !== null) window.clearTimeout(timer);
  };
}

function scheduleClick(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  accent: boolean,
  volume: number,
): ClickNodes {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const clickDuration = accent ? 0.055 : 0.04;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(accent ? 1_760 : 1_180, time);
  oscillator.frequency.exponentialRampToValueAtTime(accent ? 1_280 : 880, time + clickDuration);
  gain.gain.setValueAtTime(0.0001, Math.max(context.currentTime, time - 0.002));
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + clickDuration);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(time);
  oscillator.stop(time + clickDuration + 0.005);
  oscillator.addEventListener(
    "ended",
    () => {
      oscillator.disconnect();
      gain.disconnect();
    },
    { once: true },
  );
  return { oscillator, gain };
}

function waitUntilAudioTime(
  context: BaseAudioContext,
  targetTime: number,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signals.some((signal) => signal?.aborted)) {
      reject(new DOMException("카운트인이 취소됐어요.", "AbortError"));
      return;
    }
    let timer: number | null = null;
    let settled = false;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("카운트인이 취소됐어요.", "AbortError"));
    };
    const check = () => {
      if (settled) return;
      if (context.state === "closed") {
        settled = true;
        cleanup();
        reject(new Error("오디오 엔진이 종료되어 카운트인을 마치지 못했어요."));
        return;
      }
      const remainingMs = (targetTime - context.currentTime) * 1_000;
      if (remainingMs <= 1) {
        settled = true;
        cleanup();
        resolve();
        return;
      }
      timer = window.setTimeout(check, Math.min(100, Math.max(1, remainingMs)));
    };
    for (const signal of signals) signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

/** Schedules a finite count-in and returns the exact Web Audio start time. */
export function scheduleCountIn(
  context: BaseAudioContext,
  destination: AudioNode = context.destination,
  options: CountInOptions,
): CountInSchedule {
  if (context.state === "closed") throw new Error("오디오 엔진이 이미 종료됐어요.");
  const bpm = validBpm(options.bpm);
  const beatsPerBar = validBeatsPerBar(options.beatsPerBar);
  const subdivision = validSubdivision(options.subdivision);
  const requestedBars = options.bars;
  const bars = typeof requestedBars === "number" && Number.isFinite(requestedBars)
    ? Math.min(8, Math.max(1, Math.floor(requestedBars)))
    : 1;
  const volume = clamp(
    typeof options.volume === "number" && Number.isFinite(options.volume) ? options.volume : 0.3,
    0,
    1,
  );
  const interval = 60 / bpm / subdivision;
  const totalSteps = bars * beatsPerBar * subdivision;
  const firstTime = audioStartTime(context, options.startTime);
  const nodes: ClickNodes[] = [];
  const beats: MetronomeBeat[] = [];
  const cancellation = new AbortController();
  let cancelled = false;
  let nextCallbackIndex = 0;
  let cancelBeatCallback: (() => void) | null = null;

  for (let index = 0; index < totalSteps; index += 1) {
    const wholeBeatIndex = Math.floor(index / subdivision);
    const beatInBar = wholeBeatIndex % beatsPerBar;
    const isWholeBeat = index % subdivision === 0;
    const event: MetronomeBeat = {
      index,
      beatInBar,
      bar: Math.floor(wholeBeatIndex / beatsPerBar),
      isAccent: isWholeBeat && beatInBar === 0,
      isCountIn: true,
      audioTime: firstTime + index * interval,
    };
    beats.push(event);
    nodes.push(
      scheduleClick(
        context,
        destination,
        event.audioTime,
        event.isAccent,
        isWholeBeat ? volume : volume * 0.55,
      ),
    );
  }

  const scheduleNextBeatCallback = () => {
    const nextBeat = beats[nextCallbackIndex];
    if (cancelled || !options.onBeat || !nextBeat) return;
    cancelBeatCallback = scheduleAtAudioTime(context, nextBeat.audioTime, () => {
      if (cancelled) return;
      // If JavaScript was throttled, report only the latest due beat rather
      // than flooding the UI with a burst of stale callbacks.
      let latestDueBeat: MetronomeBeat | undefined;
      while ((beats[nextCallbackIndex]?.audioTime ?? Number.POSITIVE_INFINITY) <= context.currentTime + 0.002) {
        latestDueBeat = beats[nextCallbackIndex];
        nextCallbackIndex += 1;
      }
      if (latestDueBeat) options.onBeat?.(latestDueBeat);
      scheduleNextBeatCallback();
    });
  };
  scheduleNextBeatCallback();

  const recordingStartTime = firstTime + totalSteps * interval;
  return {
    recordingStartTime,
    beats,
    wait(signal) {
      if (cancelled) return Promise.reject(new DOMException("카운트인이 취소됐어요.", "AbortError"));
      return waitUntilAudioTime(context, recordingStartTime, [cancellation.signal, signal]);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      cancellation.abort();
      cancelBeatCallback?.();
      cancelBeatCallback = null;
      for (const { oscillator, gain } of nodes) {
        try {
          oscillator.stop();
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          // A click may already have ended.
        }
      }
    },
  };
}

/**
 * Look-ahead metronome for long-running playback. It uses AudioContext time for
 * accuracy and a short JavaScript timer only to fill the scheduling horizon.
 */
export class MetronomeScheduler {
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private timer: number | null = null;
  private nodes = new Set<ClickNodes>();
  private callbackCancellations = new Set<() => void>();
  private completionCancellation: (() => void) | null = null;
  private running = false;
  private nextIndex = 0;
  private nextTime = 0;
  private countInSteps = 0;
  private musicalStartTime = 0;
  private stopAtTime = Number.POSITIVE_INFINITY;
  private currentOptions: Required<
    Pick<MetronomeOptions, "bpm" | "beatsPerBar" | "subdivision" | "countInBars" | "volume">
  > & { onBeat?: MetronomeOptions["onBeat"] } = {
    bpm: 120,
    beatsPerBar: 4,
    subdivision: 1,
    countInBars: 0,
    volume: 0.3,
  };

  constructor(context: AudioContext, destination: AudioNode = context.destination) {
    this.context = context;
    this.destination = destination;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get recordingStartTime(): number {
    return this.musicalStartTime;
  }

  start(options: MetronomeOptions): { recordingStartTime: number; stop: () => void } {
    this.stop();
    if (this.context.state === "closed") throw new Error("오디오 엔진이 이미 종료됐어요.");
    const bpm = validBpm(options.bpm);
    const beatsPerBar = validBeatsPerBar(options.beatsPerBar);
    const subdivision = validSubdivision(options.subdivision);
    const countInBars = Math.min(64, Math.max(0, Math.floor(nonNegative(options.countInBars))));
    this.currentOptions = {
      bpm,
      beatsPerBar,
      subdivision,
      countInBars,
      volume: clamp(
        typeof options.volume === "number" && Number.isFinite(options.volume)
          ? options.volume
          : 0.3,
        0,
        1,
      ),
      onBeat: options.onBeat,
    };
    this.countInSteps = countInBars * beatsPerBar * subdivision;
    this.nextIndex = -this.countInSteps;
    this.nextTime = audioStartTime(this.context, options.startTime);
    const interval = 60 / bpm / subdivision;
    this.musicalStartTime = this.nextTime + this.countInSteps * interval;
    this.stopAtTime = options.durationSeconds !== undefined
      ? this.musicalStartTime + nonNegative(options.durationSeconds)
      : Number.POSITIVE_INFINITY;

    this.running = this.nextTime < this.stopAtTime;
    this.fillHorizon();
    if (this.nextTime < this.stopAtTime) {
      this.timer = window.setInterval(() => this.fillHorizon(), 25);
    }
    if (this.running && Number.isFinite(this.stopAtTime)) {
      this.completionCancellation = scheduleAtAudioTime(
        this.context,
        this.stopAtTime,
        () => {
          this.completionCancellation = null;
          this.stop();
        },
      );
    }
    return { recordingStartTime: this.musicalStartTime, stop: () => this.stop() };
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.completionCancellation?.();
    this.completionCancellation = null;
    for (const cancelCallback of this.callbackCancellations) cancelCallback();
    this.callbackCancellations.clear();
    for (const nodes of this.nodes) {
      try {
        nodes.oscillator.stop();
        nodes.oscillator.disconnect();
        nodes.gain.disconnect();
      } catch {
        // A scheduled click may already have ended.
      }
    }
    this.nodes.clear();
  }

  private fillHorizon(): void {
    if (this.context.state === "closed") {
      this.stop();
      return;
    }
    const horizon = this.context.currentTime + 0.12;
    const { bpm, beatsPerBar, subdivision, volume, onBeat } = this.currentOptions;
    const interval = 60 / bpm / subdivision;

    // Timer throttling (for example in a background tab) must not enqueue a
    // burst of every missed click. Keep the musical phase and resume ahead.
    const minimumScheduleTime = this.context.currentTime + 0.01;
    if (this.nextTime < minimumScheduleTime) {
      const skippedSteps = Math.ceil((minimumScheduleTime - this.nextTime) / interval);
      this.nextIndex += skippedSteps;
      this.nextTime += skippedSteps * interval;
    }

    while (this.nextTime < horizon && this.nextTime < this.stopAtTime) {
      const timelineIndex = this.nextIndex;
      const countInIndex = timelineIndex + this.countInSteps;
      const logicalIndex = timelineIndex < 0 ? countInIndex : timelineIndex;
      const wholeBeatIndex = Math.floor(logicalIndex / subdivision);
      const beatInBar = ((wholeBeatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
      const isWholeBeat = logicalIndex % subdivision === 0;
      const event: MetronomeBeat = {
        index: timelineIndex,
        beatInBar,
        bar: Math.floor(wholeBeatIndex / beatsPerBar),
        isAccent: isWholeBeat && beatInBar === 0,
        isCountIn: timelineIndex < 0,
        audioTime: this.nextTime,
      };
      const nodes = scheduleClick(
        this.context,
        this.destination,
        this.nextTime,
        event.isAccent,
        isWholeBeat ? volume : volume * 0.55,
      );
      this.nodes.add(nodes);
      nodes.oscillator.addEventListener("ended", () => this.nodes.delete(nodes), { once: true });
      if (onBeat) {
        let fired = false;
        let cancelCallback: (() => void) | null = null;
        cancelCallback = scheduleAtAudioTime(this.context, event.audioTime, () => {
          fired = true;
          if (cancelCallback) this.callbackCancellations.delete(cancelCallback);
          onBeat(event);
        });
        if (!fired) this.callbackCancellations.add(cancelCallback);
      }
      this.nextIndex += 1;
      this.nextTime += interval;
    }

    if (this.nextTime >= this.stopAtTime && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
