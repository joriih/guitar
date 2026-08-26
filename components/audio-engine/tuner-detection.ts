import { clamp } from "./browser";

export type PitchDetection = {
  frequency: number;
  confidence: number;
  midi: number;
  note: string;
  octave: number;
  cents: number;
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;

export function frequencyToPitch(frequency: number, confidence = 1): PitchDetection | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const exactMidi = 69 + 12 * Math.log2(frequency / 440);
  const midi = Math.round(exactMidi);
  const noteIndex = ((midi % 12) + 12) % 12;
  return {
    frequency,
    confidence: clamp(confidence, 0, 1),
    midi,
    note: NOTE_NAMES[noteIndex] ?? "–",
    octave: Math.floor(midi / 12) - 1,
    cents: Math.round(1_200 * Math.log2(frequency / (440 * 2 ** ((midi - 69) / 12)))),
  };
}

/**
 * Normalized autocorrelation with parabolic peak interpolation. It selects the
 * first strong periodic peak and leaves short attack spikes to the hook's
 * temporal stabilizer.
 */
export function detectPitchAutocorrelation(
  samples: Float32Array,
  sampleRate: number,
  options: { minFrequency?: number; maxFrequency?: number; rmsThreshold?: number } = {},
): PitchDetection | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length < 32) return null;
  const minFrequency = clamp(options.minFrequency ?? 65, 20, 2_000);
  const maxFrequency = clamp(options.maxFrequency ?? 1_200, minFrequency + 1, sampleRate / 2);
  const minimumLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maximumLag = Math.min(samples.length - 2, Math.ceil(sampleRate / minFrequency));
  if (maximumLag <= minimumLag) return null;
  const analysisLength = Math.min(
    samples.length,
    Math.max(2_048, maximumLag * 3),
  );

  let mean = 0;
  for (let index = 0; index < analysisLength; index += 1) mean += samples[index] ?? 0;
  mean /= analysisLength;

  let squared = 0;
  for (let index = 0; index < analysisLength; index += 1) {
    const sample = (samples[index] ?? 0) - mean;
    squared += sample * sample;
  }
  const rms = Math.sqrt(squared / analysisLength);
  if (rms < (options.rmsThreshold ?? 0.008)) return null;

  const correlations = new Float32Array(maximumLag + 1);
  let bestLag = minimumLag;
  let bestCorrelation = -1;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let product = 0;
    let energyA = 0;
    let energyB = 0;
    const count = analysisLength - lag;
    for (let index = 0; index < count; index += 1) {
      const a = (samples[index] ?? 0) - mean;
      const b = (samples[index + lag] ?? 0) - mean;
      product += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denominator = Math.sqrt(energyA * energyB);
    const correlation = denominator > 0 ? product / denominator : 0;
    correlations[lag] = correlation;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (bestCorrelation < 0.55) return null;

  const strongPeakThreshold = Math.max(0.68, bestCorrelation * 0.92);
  for (let lag = minimumLag + 1; lag < maximumLag; lag += 1) {
    const value = correlations[lag] ?? 0;
    if (
      value >= strongPeakThreshold &&
      value >= (correlations[lag - 1] ?? 0) &&
      value > (correlations[lag + 1] ?? 0)
    ) {
      bestLag = lag;
      bestCorrelation = value;
      break;
    }
  }

  const left = correlations[bestLag - 1] ?? bestCorrelation;
  const center = correlations[bestLag] ?? bestCorrelation;
  const right = correlations[bestLag + 1] ?? bestCorrelation;
  const curve = left - 2 * center + right;
  const correction = Math.abs(curve) > 1e-8 ? 0.5 * (left - right) / curve : 0;
  const interpolatedLag = bestLag + clamp(correction, -1, 1);
  return frequencyToPitch(sampleRate / interpolatedLag, bestCorrelation);
}

export type GuitarStringMatch = {
  name: "6번 E" | "5번 A" | "4번 D" | "3번 G" | "2번 B" | "1번 E";
  frequency: number;
  cents: number;
};

const STANDARD_GUITAR_STRINGS: ReadonlyArray<Omit<GuitarStringMatch, "cents">> = [
  { name: "6번 E", frequency: 82.4069 },
  { name: "5번 A", frequency: 110 },
  { name: "4번 D", frequency: 146.8324 },
  { name: "3번 G", frequency: 195.9977 },
  { name: "2번 B", frequency: 246.9417 },
  { name: "1번 E", frequency: 329.6276 },
];

export function closestStandardGuitarString(frequency: number): GuitarStringMatch | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  let closest = STANDARD_GUITAR_STRINGS[0];
  let closestCents = Number.POSITIVE_INFINITY;
  for (const string of STANDARD_GUITAR_STRINGS) {
    const cents = 1_200 * Math.log2(frequency / string.frequency);
    if (Math.abs(cents) < Math.abs(closestCents)) {
      closest = string;
      closestCents = cents;
    }
  }
  return closest ? { ...closest, cents: Math.round(closestCents) } : null;
}
