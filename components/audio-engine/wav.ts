import { assertBrowserAudio, clamp, nonNegative } from "./browser";
import {
  buildCompTimeline,
  getTimelineDuration,
  scheduleTimelineTracks,
  type CompAudioSegment,
  type CompBuildOptions,
  type TimelineTrack,
} from "./timeline";

export type OfflineMixOptions = {
  sampleRate?: number;
  channels?: number;
  masterVolume?: number;
  fromSeconds?: number;
  durationSeconds?: number;
  tailSeconds?: number;
  normalize?: boolean | { targetPeak?: number };
  /** Guard against browser crashes from oversized OfflineAudioContext buffers. */
  maxRenderBytes?: number;
};

export type PcmWavOptions = {
  bitDepth?: 16 | 24 | 32;
  float?: boolean;
};

export type SelectedTakeMixOptions = OfflineMixOptions & {
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  volume?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
};

function resolveChannelCount(tracks: readonly TimelineTrack[], requested?: number): number {
  if (requested !== undefined) return Math.floor(clamp(requested, 1, 32));
  const sourceChannels = tracks.reduce(
    (maximum, track) => Math.max(maximum, track.buffer.numberOfChannels),
    1,
  );
  // Stereo is the useful default for guitar and backing-track export.
  return Math.min(2, sourceChannels);
}

function resolveSampleRate(tracks: readonly TimelineTrack[], requested?: number): number {
  if (requested !== undefined) return Math.floor(clamp(requested, 8_000, 192_000));
  const highestSourceRate = tracks.reduce(
    (highest, track) => Math.max(highest, track.buffer.sampleRate),
    44_100,
  );
  return Math.min(48_000, highestSourceRate);
}

function normalizeRenderedBuffer(buffer: AudioBuffer, targetPeak: number): void {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      peak = Math.max(peak, Math.abs(data[index] ?? 0));
    }
  }
  if (peak < 0.0001) return;
  const scale = targetPeak / peak;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] *= scale;
  }
}

/** Renders takes, comps, or multitrack arrangements without real-time playback. */
export async function renderOfflineMix(
  tracks: readonly TimelineTrack[],
  options: OfflineMixOptions = {},
): Promise<AudioBuffer> {
  assertBrowserAudio();
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("이 브라우저는 오디오 내보내기를 지원하지 않아요.");
  }
  if (tracks.length === 0) throw new Error("내보낼 오디오가 없어요.");

  const sampleRate = resolveSampleRate(tracks, options.sampleRate);
  const channels = resolveChannelCount(tracks, options.channels);
  const fromSeconds = nonNegative(options.fromSeconds);
  const availableDuration = Math.max(0, getTimelineDuration(tracks) - fromSeconds);
  const mixDuration = Math.min(
    availableDuration,
    options.durationSeconds === undefined
      ? availableDuration
      : nonNegative(options.durationSeconds),
  );
  if (mixDuration <= 0) throw new Error("내보낼 오디오 구간이 비어 있어요.");
  const tailSeconds = Math.min(30, nonNegative(options.tailSeconds));
  const totalDuration = mixDuration + tailSeconds;

  const frameCount = Math.ceil(totalDuration * sampleRate);
  if (!Number.isSafeInteger(frameCount) || frameCount > 0x7fffffff) {
    throw new Error("내보내기 구간이 너무 길어요.");
  }
  const renderBytes = frameCount * channels * Float32Array.BYTES_PER_ELEMENT;
  const requestedMaxBytes = options.maxRenderBytes;
  const maxRenderBytes = typeof requestedMaxBytes === "number" && !Number.isNaN(requestedMaxBytes)
    ? Math.max(1, requestedMaxBytes)
    : 256 * 1024 * 1024;
  if (Number.isFinite(maxRenderBytes) && renderBytes > Math.max(1, maxRenderBytes)) {
    throw new Error("내보내기 구간이 너무 길어 브라우저 메모리를 초과해요. 구간을 나눠서 내보내주세요.");
  }

  const context = new OfflineAudioContext(channels, frameCount, sampleRate);
  const master = context.createGain();
  master.gain.value = clamp(options.masterVolume ?? 1, 0, 4);
  master.connect(context.destination);
  scheduleTimelineTracks(context, tracks, master, {
    when: 0,
    fromSeconds,
    untilSeconds: fromSeconds + mixDuration,
  });
  const rendered = await context.startRendering();

  if (options.normalize) {
    const target = typeof options.normalize === "object" ? options.normalize.targetPeak ?? 0.98 : 0.98;
    normalizeRenderedBuffer(rendered, clamp(target, 0.01, 1));
  }
  return rendered;
}

export async function renderSelectedTake(
  buffer: AudioBuffer,
  options: SelectedTakeMixOptions = {},
): Promise<AudioBuffer> {
  const trimStart = Math.min(buffer.duration, nonNegative(options.trimStartSeconds));
  const trimEnd = Math.min(
    buffer.duration,
    options.trimEndSeconds === undefined ? buffer.duration : nonNegative(options.trimEndSeconds),
  );
  if (trimEnd <= trimStart) throw new Error("선택한 테이크 구간이 비어 있어요.");
  return renderOfflineMix(
    [
      {
        id: "selected-take",
        buffer,
        sourceOffsetSeconds: trimStart,
        durationSeconds: trimEnd - trimStart,
        volume: options.volume,
        fadeInSeconds: options.fadeInSeconds,
        fadeOutSeconds: options.fadeOutSeconds,
      },
    ],
    options,
  );
}

export async function renderCompMix(
  segments: readonly CompAudioSegment[],
  options: OfflineMixOptions & CompBuildOptions = {},
): Promise<AudioBuffer> {
  return renderOfflineMix(buildCompTimeline(segments, options), options);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function finiteSample(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, -1, 1);
}

/** Encodes interleaved little-endian PCM (or IEEE float) in a RIFF/WAVE file. */
export function encodePcmWav(audio: AudioBuffer, options: PcmWavOptions = {}): Blob {
  const bitDepth = options.float ? 32 : options.bitDepth ?? 16;
  if (![16, 24, 32].includes(bitDepth)) throw new Error("지원하지 않는 WAV 비트 깊이예요.");
  if (options.float && options.bitDepth !== undefined && options.bitDepth !== 32) {
    throw new Error("부동소수점 WAV는 32비트만 지원해요.");
  }
  const bytesPerSample = bitDepth / 8;
  const channels = audio.numberOfChannels;
  const sampleCount = audio.length;
  const dataBytes = sampleCount * channels * bytesPerSample;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffffffff - 36) {
    throw new Error("WAV 파일이 RIFF 형식의 최대 크기를 넘어요.");
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, options.float ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const channelData = Array.from({ length: channels }, (_, channel) =>
    audio.getChannelData(channel),
  );
  const bytesPerFrame = channels * bytesPerSample;
  const framesPerChunk = Math.max(1, Math.floor((1024 * 1024) / bytesPerFrame));
  const parts: BlobPart[] = [header];
  for (let firstFrame = 0; firstFrame < sampleCount; firstFrame += framesPerChunk) {
    const frames = Math.min(framesPerChunk, sampleCount - firstFrame);
    const chunk = new ArrayBuffer(frames * bytesPerFrame);
    const chunkView = new DataView(chunk);
    let offset = 0;
    for (let localFrame = 0; localFrame < frames; localFrame += 1) {
      const frame = firstFrame + localFrame;
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = finiteSample(channelData[channel]?.[frame] ?? 0);
        if (options.float) {
          chunkView.setFloat32(offset, sample, true);
        } else if (bitDepth === 16) {
          chunkView.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
        } else if (bitDepth === 24) {
          const value = sample < 0
            ? Math.round(sample * 0x800000)
            : Math.round(sample * 0x7fffff);
          chunkView.setUint8(offset, value & 0xff);
          chunkView.setUint8(offset + 1, (value >> 8) & 0xff);
          chunkView.setUint8(offset + 2, (value >> 16) & 0xff);
        } else {
          chunkView.setInt32(
            offset,
            sample < 0 ? Math.round(sample * 0x80000000) : Math.round(sample * 0x7fffffff),
            true,
          );
        }
        offset += bytesPerSample;
      }
    }
    parts.push(chunk);
  }
  return new Blob(parts, { type: "audio/wav" });
}

export function safeWavFileName(name: string): string {
  const clean = name
    .replace(/\.wav$/i, "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${clean || "riff"}.wav`;
}

export function downloadAudioBlob(blob: Blob, fileName: string): void {
  assertBrowserAudio();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function mixdownToWav(
  tracks: readonly TimelineTrack[],
  options: OfflineMixOptions & PcmWavOptions = {},
): Promise<Blob> {
  const rendered = await renderOfflineMix(tracks, options);
  return encodePcmWav(rendered, options);
}

export async function mixdownAndDownload(
  tracks: readonly TimelineTrack[],
  fileName: string,
  options: OfflineMixOptions & PcmWavOptions = {},
): Promise<Blob> {
  const wav = await mixdownToWav(tracks, options);
  downloadAudioBlob(wav, safeWavFileName(fileName.replace(/\.wav$/i, "")));
  return wav;
}
