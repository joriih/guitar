import { createAudioContext, isAudioBuffer } from "./browser";
import {
  decodeAudioSource,
  type AudioSourceInput,
  type TimelineTrack,
  type TimelineTrackSource,
} from "./timeline";

export type AudioDecodeCacheOptions = {
  /** Approximate decoded PCM bytes retained by the cache. Defaults to 192 MiB. */
  maxBytes?: number;
  maxEntries?: number;
};

export type AudioDecodeLoadOptions = {
  signal?: AbortSignal;
  /** Required to cache Blob or ArrayBuffer inputs. URL inputs are keyed automatically. */
  cacheKey?: string;
};

type CacheEntry = {
  buffer: AudioBuffer;
  bytes: number;
};

const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 24;

function decodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function automaticKey(source: AudioSourceInput): string | null {
  if (typeof source !== "string") return null;
  if (typeof window === "undefined") return source;
  return new URL(source, window.location.href).href;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("작업이 취소됐어요.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("작업이 취소됐어요.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Component-owned decoded PCM cache. It coalesces concurrent URL loads, keeps
 * memory bounded with LRU eviction, and closes its decoder context on dispose.
 */
export class AudioDecodeCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<AudioBuffer>>();
  private readonly disposal = new AbortController();
  private context: AudioContext | null = null;
  private retainedBytes = 0;
  private epoch = 0;
  private readonly keyVersions = new Map<string, number>();
  private disposed = false;

  constructor(options: AudioDecodeCacheOptions = {}) {
    this.maxBytes = typeof options.maxBytes === "number" && !Number.isNaN(options.maxBytes)
      ? Math.max(0, options.maxBytes)
      : DEFAULT_MAX_BYTES;
    this.maxEntries = typeof options.maxEntries === "number" && !Number.isNaN(options.maxEntries)
      ? Math.max(1, Math.floor(options.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  }

  get cachedBytes(): number {
    return this.retainedBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  async load(
    source: AudioSourceInput,
    options: AudioDecodeLoadOptions = {},
  ): Promise<AudioBuffer> {
    this.assertUsable();
    if (isAudioBuffer(source)) return source;
    if (options.signal?.aborted) throw new DOMException("작업이 취소됐어요.", "AbortError");

    const key = options.cacheKey ?? automaticKey(source);
    if (key) {
      const cached = this.entries.get(key);
      if (cached) {
        // Map insertion order doubles as an inexpensive LRU list.
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.buffer;
      }
      const inFlight = this.pending.get(key);
      if (inFlight) return abortable(inFlight, options.signal);
    }

    const context = this.ensureContext();
    const operationEpoch = this.epoch;
    const keyVersion = key ? this.keyVersions.get(key) ?? 0 : 0;
    // Caller cancellation only detaches that caller. The shared decode remains
    // useful to a rapid next selection and is cancelled only on cache disposal.
    const operation = decodeAudioSource(context, source, { signal: this.disposal.signal }).then(
      (buffer) => {
        if (this.disposed) throw new DOMException("오디오 캐시가 종료됐어요.", "AbortError");
        if (
          key &&
          operationEpoch === this.epoch &&
          keyVersion === (this.keyVersions.get(key) ?? 0)
        ) {
          this.store(key, buffer);
        }
        return buffer;
      },
    );

    if (key) {
      this.pending.set(key, operation);
      const removePending = () => {
        if (this.pending.get(key) === operation) this.pending.delete(key);
      };
      void operation.then(removePending, removePending);
    }
    return abortable(operation, options.signal);
  }

  async loadTracks(
    sources: readonly TimelineTrackSource[],
    options: { signal?: AbortSignal } = {},
  ): Promise<TimelineTrack[]> {
    return Promise.all(
      sources.map(async ({ source, ...track }) => ({
        ...track,
        buffer: await this.load(source, { signal: options.signal }),
      })),
    );
  }

  invalidate(sourceOrKey: AudioSourceInput | string): void {
    const keys = typeof sourceOrKey === "string"
      ? new Set([sourceOrKey, automaticKey(sourceOrKey)].filter((key): key is string => Boolean(key)))
      : new Set([automaticKey(sourceOrKey)].filter((key): key is string => Boolean(key)));
    for (const key of keys) {
      this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
      this.pending.delete(key);
      const entry = this.entries.get(key);
      if (entry) this.retainedBytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.keyVersions.clear();
    this.entries.clear();
    this.retainedBytes = 0;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposal.abort();
    this.clear();
    this.pending.clear();
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      this.context = createAudioContext({ latencyHint: "playback" });
    }
    return this.context;
  }

  private store(key: string, buffer: AudioBuffer): void {
    const bytes = decodedBytes(buffer);
    if (bytes > this.maxBytes || this.maxBytes === 0) return;
    const previous = this.entries.get(key);
    if (previous) this.retainedBytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, { buffer, bytes });
    this.retainedBytes += bytes;

    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) this.retainedBytes -= oldest.bytes;
      this.entries.delete(oldestKey);
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("이미 종료된 오디오 캐시예요.");
  }
}
