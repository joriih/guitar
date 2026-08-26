export function assertBrowserAudio(): void {
  if (typeof window === "undefined") {
    throw new Error("오디오 기능은 브라우저에서만 사용할 수 있어요.");
  }
}

type BrowserWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

export function createAudioContext(options?: AudioContextOptions): AudioContext {
  assertBrowserAudio();
  const browserWindow = window as BrowserWindow;
  const Context = browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
  if (!Context) {
    throw new Error("이 브라우저는 Web Audio를 지원하지 않아요.");
  }
  return new Context(options);
}

export function isAudioBuffer(value: unknown): value is AudioBuffer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AudioBuffer>;
  return (
    typeof candidate.duration === "number" &&
    typeof candidate.sampleRate === "number" &&
    typeof candidate.numberOfChannels === "number" &&
    typeof candidate.getChannelData === "function"
  );
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function nonNegative(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

