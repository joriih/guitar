import { clamp, createAudioContext, isAudioBuffer, nonNegative } from "./browser";

export type AudioSourceInput = AudioBuffer | ArrayBuffer | Blob | string;

export type TimelineTrack = {
  id: string;
  buffer: AudioBuffer;
  /** Where this clip starts on the project timeline. */
  offsetSeconds?: number;
  /** Where playback starts inside the source file. */
  sourceOffsetSeconds?: number;
  /** Defaults to the remaining source duration. */
  durationSeconds?: number;
  volume?: number;
  pan?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  muted?: boolean;
  solo?: boolean;
};

export type TimelineTrackSource = Omit<TimelineTrack, "buffer"> & {
  source: AudioSourceInput;
};

export type CompAudioSegment = {
  id: string;
  takeId: string;
  buffer: AudioBuffer;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  volume?: number;
  pan?: number;
};

export type CompBuildOptions = {
  crossfadeSeconds?: number;
};

export type ScheduleTimelineOptions = {
  when?: number;
  fromSeconds?: number;
  untilSeconds?: number;
  onSourceEnded?: (trackId: string) => void;
};

export type ScheduledTimeline = {
  sources: AudioBufferSourceNode[];
  duration: number;
  stop: (atTime?: number) => void;
};

export type TimelinePlaybackState = "idle" | "loading" | "playing" | "paused" | "disposed";

export type TimelinePlaybackSnapshot = {
  state: TimelinePlaybackState;
  currentTime: number;
  duration: number;
};

export type TimelinePlayOptions = {
  fromSeconds?: number;
  onEnded?: () => void;
};

const MIN_SCHEDULE_DURATION = 1 / 48_000;

function resolvedTrackDuration(track: TimelineTrack): number {
  const sourceStart = nonNegative(track.sourceOffsetSeconds);
  const available = Math.max(0, track.buffer.duration - sourceStart);
  if (track.durationSeconds === undefined) return available;
  return Math.min(available, nonNegative(track.durationSeconds));
}

export function getTimelineDuration(tracks: readonly TimelineTrack[]): number {
  return getAudibleTimelineTracks(tracks).reduce((duration, track) => {
    return Math.max(duration, nonNegative(track.offsetSeconds) + resolvedTrackDuration(track));
  }, 0);
}

/** Applies DAW-style solo gating first, then excludes explicitly muted tracks. */
export function getAudibleTimelineTracks<T extends TimelineTrack>(tracks: readonly T[]): T[] {
  const hasSolo = tracks.some((track) => track.solo === true);
  return tracks.filter((track) => !track.muted && (!hasSolo || track.solo === true));
}

function envelopeValue(
  localTime: number,
  duration: number,
  baseVolume: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let envelope = 1;
  if (fadeIn > 0 && localTime < fadeIn) envelope = Math.min(envelope, localTime / fadeIn);
  if (fadeOut > 0 && localTime > duration - fadeOut) {
    envelope = Math.min(envelope, Math.max(0, (duration - localTime) / fadeOut));
  }
  return baseVolume * clamp(envelope, 0, 1);
}

function scheduleGainEnvelope(options: {
  gain: AudioParam;
  scheduleTime: number;
  localStart: number;
  segmentDuration: number;
  trackDuration: number;
  baseVolume: number;
  fadeIn: number;
  fadeOut: number;
}) {
  const {
    gain,
    scheduleTime,
    localStart,
    segmentDuration,
    trackDuration,
    baseVolume,
    fadeIn,
    fadeOut,
  } = options;
  const localEnd = localStart + segmentDuration;
  const breakpoints = [localStart, localEnd];
  if (fadeIn > localStart && fadeIn < localEnd) breakpoints.push(fadeIn);
  const fadeOutStart = trackDuration - fadeOut;
  if (fadeOut > 0 && fadeOutStart > localStart && fadeOutStart < localEnd) {
    breakpoints.push(fadeOutStart);
  }
  // Overlapping fades change slope where both ramps meet, rather than at
  // either fade boundary. Scheduling that point keeps preview and export exact.
  if (fadeIn > 0 && fadeOut > 0 && fadeIn + fadeOut > trackDuration) {
    const intersection = (trackDuration * fadeIn) / (fadeIn + fadeOut);
    if (intersection > localStart && intersection < localEnd) breakpoints.push(intersection);
  }
  const uniqueBreakpoints = [...new Set(breakpoints)].sort((a, b) => a - b);

  gain.cancelScheduledValues(scheduleTime);
  gain.setValueAtTime(
    envelopeValue(localStart, trackDuration, baseVolume, fadeIn, fadeOut),
    scheduleTime,
  );
  for (const point of uniqueBreakpoints.slice(1)) {
    gain.linearRampToValueAtTime(
      envelopeValue(point, trackDuration, baseVolume, fadeIn, fadeOut),
      scheduleTime + (point - localStart),
    );
  }
}

/**
 * Schedules already-decoded clips on any Web Audio context, including an
 * OfflineAudioContext. The returned handle owns only nodes it created.
 */
export function scheduleTimelineTracks(
  context: BaseAudioContext,
  tracks: readonly TimelineTrack[],
  destination: AudioNode,
  options: ScheduleTimelineOptions = {},
): ScheduledTimeline {
  const requestedWhen = options.when;
  const when = Number.isFinite(requestedWhen)
    ? Math.max(context.currentTime, requestedWhen ?? context.currentTime)
    : context.currentTime;
  const fromSeconds = nonNegative(options.fromSeconds);
  const requestedUntil = options.untilSeconds;
  const untilSeconds = requestedUntil === undefined || requestedUntil === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(fromSeconds, nonNegative(requestedUntil, fromSeconds));
  const sources: AudioBufferSourceNode[] = [];
  const ownedNodes: AudioNode[] = [];

  try {
    for (const track of getAudibleTimelineTracks(tracks)) {
      const trackOffset = nonNegative(track.offsetSeconds);
      const sourceOffset = nonNegative(track.sourceOffsetSeconds);
      const trackDuration = resolvedTrackDuration(track);
      const trackEnd = trackOffset + trackDuration;
      const visibleStart = Math.max(trackOffset, fromSeconds);
      const visibleEnd = Math.min(trackEnd, untilSeconds);
      const segmentDuration = visibleEnd - visibleStart;
      if (segmentDuration < MIN_SCHEDULE_DURATION) continue;

      const scheduleTime = when + (visibleStart - fromSeconds);
      const localStart = visibleStart - trackOffset;
      const bufferOffset = sourceOffset + localStart;
      const fadeIn = Math.min(trackDuration, nonNegative(track.fadeInSeconds));
      const fadeOut = Math.min(trackDuration, nonNegative(track.fadeOutSeconds));
      const baseVolume = clamp(
        typeof track.volume === "number" && Number.isFinite(track.volume) ? track.volume : 1,
        0,
        4,
      );

      const source = context.createBufferSource();
      const gain = context.createGain();
      ownedNodes.push(source, gain);
      source.buffer = track.buffer;
      scheduleGainEnvelope({
        gain: gain.gain,
        scheduleTime,
        localStart,
        segmentDuration,
        trackDuration,
        baseVolume,
        fadeIn,
        fadeOut,
      });

      let lastNode: AudioNode = source;
      const pan = clamp(
        typeof track.pan === "number" && Number.isFinite(track.pan) ? track.pan : 0,
        -1,
        1,
      );
      if (Math.abs(pan) > 0.0001 && typeof context.createStereoPanner === "function") {
        const panner = context.createStereoPanner();
        panner.pan.setValueAtTime(pan, scheduleTime);
        source.connect(panner);
        lastNode = panner;
        ownedNodes.push(panner);
      }
      lastNode.connect(gain);
      gain.connect(destination);

      source.addEventListener(
        "ended",
        () => {
          try {
            source.disconnect();
            gain.disconnect();
            if (lastNode !== source) lastNode.disconnect();
          } catch {
            // Nodes can already be disconnected by stop().
          }
          options.onSourceEnded?.(track.id);
        },
        { once: true },
      );
      source.start(scheduleTime, bufferOffset, segmentDuration);
      sources.push(source);
    }
  } catch (error) {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // A source may not have started yet.
      }
    }
    for (const node of ownedNodes) {
      try {
        node.disconnect();
      } catch {
        // Best-effort rollback of partially built graphs.
      }
    }
    throw error;
  }

  let stopped = false;
  return {
    sources,
    duration: getTimelineDuration(tracks),
    stop(atTime = context.currentTime) {
      if (stopped) return;
      stopped = true;
      const stopTime = Number.isFinite(atTime)
        ? Math.max(context.currentTime, atTime)
        : context.currentTime;
      for (const source of sources) {
        try {
          source.stop(stopTime);
        } catch {
          // A naturally-ended AudioBufferSourceNode cannot be stopped again.
        }
      }
      // For a future stop, keep the graph connected until each source emits
      // ended; disconnecting now would silence it immediately.
      if (stopTime <= context.currentTime + 0.001) {
        for (const node of ownedNodes) {
          try {
            node.disconnect();
          } catch {
            // Disconnection is intentionally idempotent.
          }
        }
      }
    },
  };
}

function assertSameOriginUrl(input: string): URL {
  if (typeof window === "undefined") {
    throw new Error("URL 오디오는 브라우저에서만 불러올 수 있어요.");
  }
  const url = new URL(input, window.location.href);
  if (url.origin !== window.location.origin || !["http:", "https:", "blob:"].includes(url.protocol)) {
    throw new Error("같은 출처의 오디오 URL만 불러올 수 있어요.");
  }
  return url;
}

export async function decodeAudioSource(
  context: BaseAudioContext,
  source: AudioSourceInput,
  options: { signal?: AbortSignal } = {},
): Promise<AudioBuffer> {
  if (isAudioBuffer(source)) return source;

  let audioData: ArrayBuffer;
  if (typeof source === "string") {
    const url = assertSameOriginUrl(source);
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`오디오를 불러오지 못했어요. (${response.status})`);
    }
    audioData = await response.arrayBuffer();
  } else if (source instanceof ArrayBuffer) {
    audioData = source.slice(0);
  } else if (typeof Blob !== "undefined" && source instanceof Blob) {
    audioData = await source.arrayBuffer();
  } else {
    throw new Error("지원하지 않는 오디오 소스예요.");
  }

  if (options.signal?.aborted) throw new DOMException("작업이 취소됐어요.", "AbortError");
  // ArrayBuffer inputs were copied above; fetch/blob buffers are already owned
  // by this function. Avoid another full-size copy for long recordings.
  return context.decodeAudioData(audioData);
}

export async function loadTimelineTrackSources(
  sources: readonly TimelineTrackSource[],
  context?: BaseAudioContext,
  options: { signal?: AbortSignal } = {},
): Promise<TimelineTrack[]> {
  const ownedContext = context ? null : createAudioContext();
  const decoder = context ?? ownedContext;
  if (!decoder) throw new Error("오디오 디코더를 만들 수 없어요.");
  try {
    return await Promise.all(
      sources.map(async ({ source, ...track }) => ({
        ...track,
        buffer: await decodeAudioSource(decoder, source, options),
      })),
    );
  } finally {
    if (ownedContext && ownedContext.state !== "closed") {
      // Teardown must not hide a more useful fetch or decode error.
      await ownedContext.close().catch(() => undefined);
    }
  }
}

export function buildCompTimeline(
  segments: readonly CompAudioSegment[],
  options: CompBuildOptions = {},
): TimelineTrack[] {
  const crossfade = nonNegative(options.crossfadeSeconds);
  const validSegments = segments.flatMap((segment) => {
    const sourceStart = Math.min(segment.buffer.duration, nonNegative(segment.sourceStartSeconds));
    const sourceEnd = Math.min(segment.buffer.duration, nonNegative(segment.sourceEndSeconds));
    const duration = sourceEnd - sourceStart;
    return duration > 0 ? [{ segment, sourceStart, duration }] : [];
  });
  let cursor = 0;
  const tracks: TimelineTrack[] = [];
  for (const [index, item] of validSegments.entries()) {
    const previous = validSegments[index - 1];
    const appliedCrossfade = previous
      ? Math.min(crossfade, previous.duration / 2, item.duration / 2)
      : 0;
    const offsetSeconds = Math.max(0, cursor - appliedCrossfade);
    cursor = offsetSeconds + item.duration;
    if (appliedCrossfade > 0) {
      const previousTrack = tracks.at(-1);
      if (previousTrack) previousTrack.fadeOutSeconds = appliedCrossfade;
    }
    tracks.push({
      id: `comp:${item.segment.id}`,
      buffer: item.segment.buffer,
      offsetSeconds,
      sourceOffsetSeconds: item.sourceStart,
      durationSeconds: item.duration,
      volume: item.segment.volume,
      pan: item.segment.pan,
      fadeInSeconds: appliedCrossfade,
      fadeOutSeconds: 0,
    });
  }
  return tracks;
}

export function scheduleCompSegments(
  context: BaseAudioContext,
  segments: readonly CompAudioSegment[],
  destination: AudioNode,
  options: ScheduleTimelineOptions & CompBuildOptions = {},
): ScheduledTimeline {
  return scheduleTimelineTracks(context, buildCompTimeline(segments, options), destination, options);
}

export class AudioTimelineEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private scheduled: ScheduledTimeline | null = null;
  private tracks: TimelineTrack[] = [];
  private listeners = new Set<(snapshot: TimelinePlaybackSnapshot) => void>();
  private playbackState: TimelinePlaybackState = "idle";
  private storedPosition = 0;
  private playbackStartedAt = 0;
  private playbackStartPosition = 0;
  private generation = 0;
  private masterVolume = 1;

  get state(): TimelinePlaybackState {
    return this.playbackState;
  }

  get currentTime(): number {
    if (this.playbackState !== "playing" || !this.context) return this.storedPosition;
    return Math.min(
      this.duration,
      this.playbackStartPosition + Math.max(0, this.context.currentTime - this.playbackStartedAt),
    );
  }

  get duration(): number {
    return getTimelineDuration(this.tracks);
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  /** Resolves at the Web Audio time at which the currently scheduled mix begins. */
  async waitForPlaybackStart(signal?: AbortSignal): Promise<void> {
    if (this.playbackState !== "playing" || !this.context) return;
    const generation = this.generation;
    const context = this.context;
    if (this.playbackStartedAt > context.currentTime) {
      await new Promise<void>((resolve, reject) => {
        let timeout: number | null = null;
        let settled = false;
        const cleanup = () => {
          if (timeout !== null) window.clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new DOMException("재생 시작이 취소됐어요.", "AbortError"));
        };
        const check = () => {
          if (
            signal?.aborted ||
            generation !== this.generation ||
            this.playbackState !== "playing" ||
            context.state === "closed"
          ) {
            fail();
            return;
          }
          const remainingMs = (this.playbackStartedAt - context.currentTime) * 1_000;
          if (remainingMs <= 1) {
            settled = true;
            cleanup();
            resolve();
            return;
          }
          timeout = window.setTimeout(check, Math.min(50, Math.max(1, remainingMs)));
        };
        const onAbort = () => fail();
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        check();
      });
    }
    if (generation !== this.generation || this.playbackState !== "playing") {
      throw new DOMException("재생 시작이 취소됐어요.", "AbortError");
    }
  }

  subscribe(listener: (snapshot: TimelinePlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setTracks(tracks: readonly TimelineTrack[]): void {
    this.assertUsable();
    const wasPlaying = this.playbackState === "playing";
    const position = this.currentTime;
    this.stopScheduled();
    this.tracks = [...tracks];
    this.storedPosition = Math.min(position, this.duration);
    this.setState(wasPlaying || this.playbackState === "loading" ? "paused" : this.playbackState);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = clamp(volume, 0, 4);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.01);
    }
  }

  async play(options: TimelinePlayOptions = {}): Promise<void> {
    return this.playTracks(this.tracks, options);
  }

  async playTracks(
    tracks: readonly TimelineTrack[],
    options: TimelinePlayOptions = {},
  ): Promise<void> {
    this.assertUsable();
    const wasPlaying = this.playbackState === "playing";
    const requestedPosition = options.fromSeconds ?? (wasPlaying ? this.currentTime : this.storedPosition);
    this.stopScheduled();
    this.tracks = [...tracks];
    const duration = this.duration;
    const fromSeconds = clamp(requestedPosition, 0, duration);
    if (duration <= 0 || fromSeconds >= duration) {
      this.storedPosition = 0;
      this.setState("idle");
      options.onEnded?.();
      return;
    }

    const generation = ++this.generation;
    this.storedPosition = fromSeconds;
    this.setState("loading");
    try {
      const context = this.ensureContext();
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) return;

      let remainingSources = 0;
      const when = context.currentTime + 0.015;
      const scheduled = scheduleTimelineTracks(context, this.tracks, this.master ?? context.destination, {
        when,
        fromSeconds,
        onSourceEnded: () => {
          if (generation !== this.generation) return;
          remainingSources -= 1;
          if (remainingSources <= 0) {
            this.scheduled = null;
            this.storedPosition = 0;
            this.playbackStartedAt = 0;
            this.setState("idle");
            options.onEnded?.();
          }
        },
      });
      remainingSources = scheduled.sources.length;
      if (remainingSources === 0) {
        this.storedPosition = 0;
        this.setState("idle");
        return;
      }

      this.scheduled = scheduled;
      this.playbackStartPosition = fromSeconds;
      this.playbackStartedAt = when;
      this.setState("playing");
    } catch (error) {
      if (generation !== this.generation) return;
      this.storedPosition = fromSeconds;
      this.playbackStartedAt = 0;
      this.setState(fromSeconds > 0 ? "paused" : "idle");
      throw error;
    }
  }

  async playComp(
    segments: readonly CompAudioSegment[],
    options: TimelinePlayOptions & CompBuildOptions = {},
  ): Promise<void> {
    return this.playTracks(buildCompTimeline(segments, options), options);
  }

  pause(): void {
    if (this.playbackState !== "playing") return;
    this.storedPosition = this.currentTime;
    this.stopScheduled();
    this.playbackStartedAt = 0;
    this.setState("paused");
  }

  stop(): void {
    if (this.playbackState === "disposed") return;
    this.stopScheduled();
    this.storedPosition = 0;
    this.playbackStartedAt = 0;
    this.setState("idle");
  }

  /** Stops playback and releases references to decoded track buffers. */
  clear(): void {
    if (this.playbackState === "disposed") return;
    this.stopScheduled();
    this.tracks = [];
    this.storedPosition = 0;
    this.playbackStartedAt = 0;
    this.playbackStartPosition = 0;
    this.setState("idle");
  }

  async seek(seconds: number): Promise<void> {
    this.assertUsable();
    const position = clamp(seconds, 0, this.duration);
    if (this.playbackState === "playing") {
      await this.play({ fromSeconds: position });
      return;
    }
    if (this.playbackState === "loading") {
      this.stopScheduled();
      this.storedPosition = position;
      this.setState(position > 0 ? "paused" : "idle");
      return;
    }
    this.storedPosition = position;
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.playbackState === "disposed") return;
    this.stopScheduled();
    this.master?.disconnect();
    this.master = null;
    if (this.context && this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.tracks = [];
    this.storedPosition = 0;
    this.playbackStartedAt = 0;
    this.setState("disposed");
    this.listeners.clear();
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      this.context = createAudioContext({ latencyHint: "interactive" });
      this.master = this.context.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.context.destination);
    }
    return this.context;
  }

  private stopScheduled(): void {
    this.generation += 1;
    this.scheduled?.stop();
    this.scheduled = null;
  }

  private assertUsable(): void {
    if (this.playbackState === "disposed") {
      throw new Error("이미 종료된 오디오 엔진이에요.");
    }
  }

  private snapshot(): TimelinePlaybackSnapshot {
    return { state: this.playbackState, currentTime: this.currentTime, duration: this.duration };
  }

  private setState(state: TimelinePlaybackState): void {
    this.playbackState = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
