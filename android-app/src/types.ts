export type RecordingMode = 'continuous' | 'event';
export type ResolutionPreset = '360p' | '240p';
export type FacingMode = 'environment' | 'user';

export interface AppSettings {
  locationLabel: string;
  recordingMode: RecordingMode;
  resolution: ResolutionPreset;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  thresholdDb: number;
  deltaThresholdDb: number;
  calibrationOffsetDb: number;
  preRollSec: number;
  postRollSec: number;
  autoSegmentMinutes: number;
  screenBrightness: number;
  facingMode: FacingMode;
}

export interface NoiseEvent {
  id: string;
  sessionId: string;
  timestamp: number;
  peakTimestamp: number;
  durationMs: number;
  peakDb: number;
  baselineDb: number;
  deltaDb: number;
  videoOffsetSec: number;
  locationLabel: string;
  snapshotDataUrl: string;
  note: string;
}

export interface RecordingSession {
  id: string;
  mode: RecordingMode;
  startTime: number;
  endTime: number;
  durationSec: number;
  mimeType: string;
  fileSize: number;
  resolution: ResolutionPreset;
  fps: number;
  locationLabel: string;
  eventCount: number;
  peakDb: number;
  videoBlob: Blob;
}

export interface AudioTelemetry {
  currentDb: number;
  baselineDb: number;
  deltaDb: number;
  peakDb: number;
  isSpikeActive: boolean;
  lastSpikeAt: number;
  lastSpikePeakDb: number;
  lastSpikeDeltaDb: number;
}

export const RESOLUTION_DIMENSIONS: Record<ResolutionPreset, { width: number; height: number; label: string }> = {
  '360p': { width: 640, height: 360, label: '360p (省空間推薦)' },
  '240p': { width: 426, height: 240, label: '240p (極致省電最小檔)' },
};

export const LOCATION_PRESETS = ['廁所洗手台', '廁所窗戶邊', '客廳朝向隔間牆'] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  locationLabel: '廁所洗手台',
  recordingMode: 'continuous',
  resolution: '360p',
  fps: 12,
  videoBitrate: 250_000,
  audioBitrate: 64_000,
  thresholdDb: 65,
  deltaThresholdDb: 12,
  calibrationOffsetDb: 95,
  preRollSec: 10,
  postRollSec: 20,
  autoSegmentMinutes: 30,
  screenBrightness: 100,
  facingMode: 'environment',
};
