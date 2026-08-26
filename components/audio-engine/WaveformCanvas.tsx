"use client";

import { useCallback, useEffect, useRef } from "react";

import { clamp, isAudioBuffer } from "./browser";
import styles from "./WaveformCanvas.module.css";

export type WaveformSelection = {
  startSeconds: number;
  endSeconds: number;
  color?: string;
};

export type WaveformCanvasProps = {
  source: AudioBuffer | Float32Array | null;
  durationSeconds?: number;
  playheadSeconds?: number;
  selection?: WaveformSelection | null;
  height?: number;
  label?: string;
  color?: string;
  backgroundColor?: string;
  className?: string;
  onSeek?: (seconds: number) => void;
};

export function extractWaveformPeaks(
  source: AudioBuffer | Float32Array,
  columns: number,
): Float32Array {
  const safeColumns = Math.max(1, Math.floor(columns));
  const peaks = new Float32Array(safeColumns * 2);
  const channels = isAudioBuffer(source)
    ? Array.from({ length: source.numberOfChannels }, (_, channel) => source.getChannelData(channel))
    : [source];
  const length = channels[0]?.length ?? 0;
  if (length === 0) return peaks;

  for (let column = 0; column < safeColumns; column += 1) {
    const start = Math.floor((column / safeColumns) * length);
    const end = Math.max(start + 1, Math.floor(((column + 1) / safeColumns) * length));
    let minimum = 1;
    let maximum = -1;
    for (let index = start; index < end; index += 1) {
      for (const channel of channels) {
        const sample = channel[index] ?? 0;
        minimum = Math.min(minimum, sample);
        maximum = Math.max(maximum, sample);
      }
    }
    peaks[column * 2] = minimum;
    peaks[column * 2 + 1] = maximum;
  }
  return peaks;
}

export function WaveformCanvas({
  source,
  durationSeconds,
  playheadSeconds = 0,
  selection = null,
  height = 96,
  label = "오디오 파형",
  color = "#c7c8c2",
  backgroundColor = "#232421",
  className,
  onSeek,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksCacheRef = useRef<{
    source: AudioBuffer | Float32Array;
    columns: number;
    peaks: Float32Array;
  } | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const resolvedDuration = Math.max(
    0,
    durationSeconds ?? (isAudioBuffer(source) ? source.duration : 0),
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(bounds.width));
    const cssHeight = Math.max(32, Math.floor(height));
    const pixelRatio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.floor(cssWidth * pixelRatio);
    const pixelHeight = Math.floor(cssHeight * pixelRatio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, cssWidth, cssHeight);

    const center = cssHeight / 2;
    context.strokeStyle = "rgba(255,255,255,.09)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, center + 0.5);
    context.lineTo(cssWidth, center + 0.5);
    context.stroke();

    if (selection && resolvedDuration > 0) {
      const start = clamp(Math.min(selection.startSeconds, selection.endSeconds), 0, resolvedDuration);
      const end = clamp(Math.max(selection.startSeconds, selection.endSeconds), 0, resolvedDuration);
      context.fillStyle = selection.color ?? "rgba(217, 52, 79, .15)";
      context.fillRect((start / resolvedDuration) * cssWidth, 0, ((end - start) / resolvedDuration) * cssWidth, cssHeight);
    }

    if (source) {
      const cached = peaksCacheRef.current;
      const peaks = cached?.source === source && cached.columns === cssWidth
        ? cached.peaks
        : extractWaveformPeaks(source, cssWidth);
      if (peaks !== cached?.peaks) {
        peaksCacheRef.current = { source, columns: cssWidth, peaks };
      }
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      const amplitude = cssHeight * 0.43;
      for (let column = 0; column < cssWidth; column += 1) {
        const minimum = peaks[column * 2] ?? 0;
        const maximum = peaks[column * 2 + 1] ?? 0;
        context.moveTo(column + 0.5, center + minimum * amplitude);
        context.lineTo(column + 0.5, center + maximum * amplitude);
      }
      context.stroke();
    } else {
      context.fillStyle = "rgba(255,255,255,.42)";
      context.font = "11px Pretendard, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("파형을 준비하고 있어요", cssWidth / 2, center);
    }

    if (resolvedDuration > 0) {
      const playheadX = (clamp(playheadSeconds, 0, resolvedDuration) / resolvedDuration) * cssWidth;
      context.strokeStyle = "#d9344f";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(playheadX + 0.5, 0);
      context.lineTo(playheadX + 0.5, cssHeight);
      context.stroke();
    }
  }, [backgroundColor, color, height, playheadSeconds, resolvedDuration, selection, source]);

  useEffect(() => {
    if (!source) peaksCacheRef.current = null;
    drawRef.current = draw;
    draw();
  }, [draw, source]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !onSeek || resolvedDuration <= 0) return;
      const bounds = canvas.getBoundingClientRect();
      const ratio = clamp((clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
      onSeek(ratio * resolvedDuration);
    },
    [onSeek, resolvedDuration],
  );

  return (
    <canvas
      ref={canvasRef}
      className={`${styles.waveform} ${onSeek ? styles.interactive : ""} ${className ?? ""}`}
      style={{ height }}
      role={onSeek ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? resolvedDuration : undefined}
      aria-valuenow={onSeek ? clamp(playheadSeconds, 0, resolvedDuration) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onPointerDown={(event) => seekFromPointer(event.clientX)}
      onKeyDown={(event) => {
        if (!onSeek || resolvedDuration <= 0) return;
        const step = Math.max(0.1, resolvedDuration / 100);
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
          event.preventDefault();
          onSeek(clamp(playheadSeconds - step, 0, resolvedDuration));
        } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
          event.preventDefault();
          onSeek(clamp(playheadSeconds + step, 0, resolvedDuration));
        } else if (event.key === "Home") {
          event.preventDefault();
          onSeek(0);
        } else if (event.key === "End") {
          event.preventDefault();
          onSeek(resolvedDuration);
        }
      }}
    />
  );
}
