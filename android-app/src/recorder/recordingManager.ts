import type { ActiveSpikeInfo, CompletedSpikeInfo } from '../audio/spikeDetector.ts';
import type { EvidenceStore } from '../storage/evidenceStore.ts';
import type { AppSettings, NoiseEvent, RecordingMode, RecordingSession } from '../types.ts';
import { createId } from '../utils/format.ts';

interface RollingSlot {
  slotIndex: 0 | 1;
  id: string;
  recorder: MediaRecorder;
  chunks: Blob[];
  startTime: number;
  mimeType: string;
  locked: boolean;
  discarded: boolean;
}

interface ActiveEventCapture {
  slot: RollingSlot;
  events: NoiseEvent[];
  peakDb: number;
  postRollTimer: number | null;
  postRollEndsAt: number;
}

export interface RecordingCallbacks {
  onRecordingStateChange?: (recording: boolean, mode: RecordingMode, startedAt: number | null) => void;
  onEventCaptured?: (event: NoiseEvent) => void;
  onSessionSaved?: (session: RecordingSession) => void;
  onCaptureStatusChange?: (statusText: string, hasPendingClip: boolean) => void;
  onError?: (message: string) => void;
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

export function detectSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore unsupported probe
    }
  }
  return '';
}

export class RecordingManager {
  private store: EvidenceStore;
  private captureSnapshot: () => string;
  private finalizeOpenSpikeFn: () => void;
  private callbacks: RecordingCallbacks;

  private settings: AppSettings;
  private stream: MediaStream | null = null;
  private isRunning = false;
  private currentMode: RecordingMode = 'continuous';
  private chosenMimeType = '';

  // Continuous mode state
  private contRecorder: MediaRecorder | null = null;
  private contChunks: Blob[] = [];
  private contSessionId = '';
  private contStartTime = 0;
  private contEvents: NoiseEvent[] = [];
  private contPeakDb = 0;
  private autoSegmentTimer: number | null = null;

  // Event mode state (dual overlapping rolling MediaRecorders)
  private slots: [RollingSlot | null, RollingSlot | null] = [null, null];
  private rotationTimer: number | null = null;
  private activeCapture: ActiveEventCapture | null = null;
  private captureCountdownTimer: number | null = null;

  // Draft event while spike is still in progress
  private draftEvent: NoiseEvent | null = null;

  constructor(
    store: EvidenceStore,
    settings: AppSettings,
    captureSnapshot: () => string,
    finalizeOpenSpikeFn: () => void,
    callbacks: RecordingCallbacks = {},
  ) {
    this.store = store;
    this.settings = { ...settings };
    this.captureSnapshot = captureSnapshot;
    this.finalizeOpenSpikeFn = finalizeOpenSpikeFn;
    this.callbacks = callbacks;
    this.chosenMimeType = detectSupportedMimeType();
  }

  public updateSettings(settings: AppSettings): void {
    this.settings = { ...settings };
  }

  public getDetectedMimeType(): string {
    return this.chosenMimeType || 'browser-default';
  }

  public isRecording(): boolean {
    return this.isRunning;
  }

  public hasActiveEventCapture(): boolean {
    return this.activeCapture !== null;
  }

  public async start(stream: MediaStream, settings: AppSettings): Promise<void> {
    if (this.isRunning) return;
    this.clearAutoSegmentTimer();
    this.clearRotationTimer();
    this.clearCaptureCountdownTimer();
    this.discardSlot(0, true);
    this.discardSlot(1, true);
    this.activeCapture = null;
    this.draftEvent = null;

    this.settings = { ...settings };
    this.stream = stream;
    this.currentMode = settings.recordingMode;
    this.chosenMimeType = detectSupportedMimeType();
    this.isRunning = true;

    if (this.currentMode === 'continuous') {
      this.startContinuousSegment();
      this.callbacks.onRecordingStateChange?.(true, 'continuous', this.contStartTime);
      this.callbacks.onCaptureStatusChange?.('全程連續錄影中・自動標記巨響時間點', false);
    } else {
      this.startEventRollingMode();
      this.callbacks.onRecordingStateChange?.(true, 'event', Date.now());
      this.callbacks.onCaptureStatusChange?.(
        `滾動緩衝待命中 (保留巨響前 ${this.settings.preRollSec}s + 後 ${this.settings.postRollSec}s)`,
        false,
      );
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.finalizeOpenSpikeFn();

    if (this.currentMode === 'continuous') {
      this.clearAutoSegmentTimer();
      await this.finalizeContinuousSegment();
    } else {
      this.clearRotationTimer();
      this.clearCaptureCountdownTimer();
      if (this.activeCapture) {
        await this.finalizeActiveEventCapture(false);
      }
      this.discardSlot(0, true);
      this.discardSlot(1, true);
    }

    this.draftEvent = null;
    this.callbacks.onRecordingStateChange?.(false, this.currentMode, null);
    this.callbacks.onCaptureStatusChange?.('已停止錄影', false);
  }

  private createMediaRecorder(stream: MediaStream): { recorder: MediaRecorder; mimeType: string } {
    const options: MediaRecorderOptions = {
      videoBitsPerSecond: this.settings.videoBitrate,
      audioBitsPerSecond: this.settings.audioBitrate,
    };
    if (this.chosenMimeType) {
      options.mimeType = this.chosenMimeType;
    }

    try {
      const recorder = new MediaRecorder(stream, options);
      return { recorder, mimeType: recorder.mimeType || this.chosenMimeType || 'video/webm' };
    } catch {
      const fallback = new MediaRecorder(stream);
      return { recorder: fallback, mimeType: fallback.mimeType || 'video/webm' };
    }
  }

  private startMediaRecorderSafe(
    recorder: MediaRecorder,
    mimeType: string,
    onChunk: (data: Blob) => void,
  ): { recorder: MediaRecorder; mimeType: string } {
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        onChunk(ev.data);
      }
    };
    try {
      recorder.start(1000);
      return { recorder, mimeType };
    } catch {
      const fallback = new MediaRecorder(this.stream as MediaStream);
      fallback.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          onChunk(ev.data);
        }
      };
      fallback.start(1000);
      return { recorder: fallback, mimeType: fallback.mimeType || 'video/webm' };
    }
  }

  // ==================== CONTINUOUS MODE ====================

  private startContinuousSegment(): void {
    if (!this.stream) return;
    const { recorder: initialRec, mimeType: initialMime } = this.createMediaRecorder(this.stream);
    const segmentChunks: Blob[] = [];
    const started = this.startMediaRecorderSafe(initialRec, initialMime, (chunk) => {
      segmentChunks.push(chunk);
    });
    this.contRecorder = started.recorder;
    this.contChunks = segmentChunks;
    this.contSessionId = createId('rec');
    this.contStartTime = Date.now();
    this.contEvents = [];
    this.contPeakDb = 0;
    this.chosenMimeType = started.mimeType;

    this.scheduleAutoSegment();
  }

  private scheduleAutoSegment(): void {
    this.clearAutoSegmentTimer();
    if (this.settings.autoSegmentMinutes <= 0) return;
    const ms = this.settings.autoSegmentMinutes * 60_000;
    this.autoSegmentTimer = window.setTimeout(() => {
      void this.rotateContinuousSegment();
    }, ms);
  }

  private clearAutoSegmentTimer(): void {
    if (this.autoSegmentTimer !== null) {
      window.clearTimeout(this.autoSegmentTimer);
      this.autoSegmentTimer = null;
    }
  }

  private async rotateContinuousSegment(): Promise<void> {
    if (!this.isRunning || this.currentMode !== 'continuous') return;
    await this.finalizeContinuousSegment();
    if (this.isRunning) {
      this.startContinuousSegment();
      this.callbacks.onRecordingStateChange?.(true, 'continuous', this.contStartTime);
    }
  }

  private async finalizeContinuousSegment(): Promise<void> {
    const recorder = this.contRecorder;
    if (!recorder) return;
    const chunks = this.contChunks;
    const sessionId = this.contSessionId;
    const startTime = this.contStartTime;
    const events = [...this.contEvents];
    const peakDb = this.contPeakDb;
    const mimeType = recorder.mimeType || this.chosenMimeType || 'video/webm';

    this.contRecorder = null;
    this.contEvents = [];

    const videoBlob = await this.stopRecorderAndBuildBlob(recorder, chunks, mimeType);
    this.contChunks = [];
    const endTime = Date.now();
    const durationSec = Math.max(1, (endTime - startTime) / 1000);

    if (videoBlob.size === 0) return;

    const session: RecordingSession = {
      id: sessionId,
      mode: 'continuous',
      startTime,
      endTime,
      durationSec,
      mimeType: videoBlob.type || mimeType,
      fileSize: videoBlob.size,
      resolution: this.settings.resolution,
      fps: this.settings.fps,
      locationLabel: this.settings.locationLabel,
      eventCount: events.length,
      peakDb,
      videoBlob,
    };

    await this.store.saveSession(session);
    this.callbacks.onSessionSaved?.(session);
  }

  // ==================== EVENT-TRIGGERED ROLLING MODE ====================

  private startEventRollingMode(): void {
    this.startSlot(0);
    this.clearRotationTimer();
    const stepMs = Math.max(4000, this.settings.preRollSec * 1000);
    this.rotationTimer = window.setInterval(() => {
      this.rotateRollingSlots();
    }, stepMs);
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer !== null) {
      window.clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  private clearCaptureCountdownTimer(): void {
    if (this.captureCountdownTimer !== null) {
      window.clearInterval(this.captureCountdownTimer);
      this.captureCountdownTimer = null;
    }
  }

  private startSlot(slotIndex: 0 | 1): RollingSlot | null {
    if (!this.stream || !this.isRunning) return null;
    const existing = this.slots[slotIndex];
    if (existing && !existing.locked) {
      this.discardSlot(slotIndex);
    }

    const { recorder: initialRec, mimeType: initialMime } = this.createMediaRecorder(this.stream);
    const slot: RollingSlot = {
      slotIndex,
      id: createId('clip'),
      recorder: initialRec,
      chunks: [],
      startTime: Date.now(),
      mimeType: initialMime,
      locked: false,
      discarded: false,
    };

    const started = this.startMediaRecorderSafe(initialRec, initialMime, (chunk) => {
      if (!slot.discarded) {
        slot.chunks.push(chunk);
      }
    });
    slot.recorder = started.recorder;
    slot.mimeType = started.mimeType;

    this.slots[slotIndex] = slot;
    return slot;
  }

  private discardSlot(slotIndex: 0 | 1, force = false): void {
    const slot = this.slots[slotIndex];
    if (!slot || (slot.locked && !force)) return;
    slot.discarded = true;
    slot.locked = false;
    slot.chunks = [];
    if (slot.recorder.state !== 'inactive') {
      try {
        slot.recorder.stop();
      } catch {
        // Ignore stop errors
      }
    }
    this.slots[slotIndex] = null;
  }

  private rotateRollingSlots(): void {
    if (!this.isRunning || this.currentMode !== 'event') return;
    const s0 = this.slots[0];
    const s1 = this.slots[1];

    if (!s0) {
      this.startSlot(0);
      return;
    }
    if (!s1) {
      this.startSlot(1);
      return;
    }

    // Both slots exist: restart whichever unlocked slot is older
    if (!s0.locked && !s1.locked) {
      const olderIndex: 0 | 1 = s0.startTime <= s1.startTime ? 0 : 1;
      this.discardSlot(olderIndex);
      this.startSlot(olderIndex);
    }
  }

  private pickBestPreRollSlot(): RollingSlot | null {
    const unlocked = this.slots.filter((s): s is RollingSlot => s !== null && !s.locked);
    if (unlocked.length === 0) return null;
    unlocked.sort((a, b) => a.startTime - b.startTime);
    return unlocked[0];
  }

  public async finalizeActiveEventCaptureNow(): Promise<void> {
    if (!this.activeCapture) return;
    await this.finalizeActiveEventCapture(this.isRunning);
  }

  private async finalizeActiveEventCapture(restartSlotAfter: boolean): Promise<void> {
    this.finalizeOpenSpikeFn();
    const capture = this.activeCapture;
    if (!capture) return;
    this.activeCapture = null;
    if (capture.postRollTimer !== null) {
      window.clearTimeout(capture.postRollTimer);
    }
    this.clearCaptureCountdownTimer();

    const { slot, events, peakDb } = capture;
    slot.locked = false;
    this.slots[slot.slotIndex] = null;

    const videoBlob = await this.stopRecorderAndBuildBlob(slot.recorder, slot.chunks, slot.mimeType);
    const endTime = Date.now();
    const durationSec = Math.max(1, (endTime - slot.startTime) / 1000);

    if (videoBlob.size > 0) {
      const session: RecordingSession = {
        id: slot.id,
        mode: 'event',
        startTime: slot.startTime,
        endTime,
        durationSec,
        mimeType: videoBlob.type || slot.mimeType,
        fileSize: videoBlob.size,
        resolution: this.settings.resolution,
        fps: this.settings.fps,
        locationLabel: this.settings.locationLabel,
        eventCount: events.length,
        peakDb,
        videoBlob,
      };
      await this.store.saveSession(session);
      for (const evt of events) {
        await this.store.saveEvent(evt);
      }
      this.callbacks.onSessionSaved?.(session);
    }

    if (restartSlotAfter && this.isRunning && this.currentMode === 'event') {
      if (!this.slots[slot.slotIndex]) {
        this.startSlot(slot.slotIndex);
      }
      this.callbacks.onCaptureStatusChange?.(
        `滾動緩衝待命中 (保留巨響前 ${this.settings.preRollSec}s + 後 ${this.settings.postRollSec}s)`,
        false,
      );
    }
  }

  // ==================== SPIKE HOOKS ====================

  public handleSpikeStart(spike: ActiveSpikeInfo): void {
    if (!this.isRunning) return;
    const snapshot = this.captureSnapshot();

    if (this.currentMode === 'continuous') {
      const offsetSec = Math.max(0, Number(((spike.startTime - this.contStartTime) / 1000).toFixed(2)));
      this.draftEvent = {
        id: spike.id,
        sessionId: this.contSessionId,
        timestamp: spike.startTime,
        peakTimestamp: spike.peakTime,
        durationMs: 200,
        peakDb: Number(spike.peakDb.toFixed(1)),
        baselineDb: Number(spike.baselineDb.toFixed(1)),
        deltaDb: Number(spike.deltaDb.toFixed(1)),
        videoOffsetSec: offsetSec,
        locationLabel: this.settings.locationLabel,
        snapshotDataUrl: snapshot,
        note: '突發巨響事件',
      };
      return;
    }

    // Event-triggered mode
    if (!this.activeCapture) {
      let slot = this.pickBestPreRollSlot();
      if (!slot) {
        const freeIdx: 0 | 1 = this.slots[0] === null ? 0 : 1;
        slot = this.startSlot(freeIdx);
      }
      if (!slot) return;

      slot.locked = true;
      // Ensure the other rolling slot stays running for subsequent events
      const otherIdx: 0 | 1 = slot.slotIndex === 0 ? 1 : 0;
      if (!this.slots[otherIdx]) {
        this.startSlot(otherIdx);
      }

      const postRollMs = Math.max(3000, this.settings.postRollSec * 1000);
      const endsAt = Date.now() + postRollMs;
      const timer = window.setTimeout(() => {
        void this.finalizeActiveEventCapture(true);
      }, postRollMs);

      this.activeCapture = {
        slot,
        events: [],
        peakDb: spike.peakDb,
        postRollTimer: timer,
        postRollEndsAt: endsAt,
      };
      this.startCaptureCountdown();
    } else {
      // Extend post-roll window for rapid consecutive slams
      if (this.activeCapture.postRollTimer !== null) {
        window.clearTimeout(this.activeCapture.postRollTimer);
      }
      const postRollMs = Math.max(3000, this.settings.postRollSec * 1000);
      this.activeCapture.postRollEndsAt = Date.now() + postRollMs;
      this.activeCapture.postRollTimer = window.setTimeout(() => {
        void this.finalizeActiveEventCapture(true);
      }, postRollMs);
    }

    const activeSlot = this.activeCapture.slot;
    const offsetSec = Math.max(0, Number(((spike.startTime - activeSlot.startTime) / 1000).toFixed(2)));
    this.draftEvent = {
      id: spike.id,
      sessionId: activeSlot.id,
      timestamp: spike.startTime,
      peakTimestamp: spike.peakTime,
      durationMs: 200,
      peakDb: Number(spike.peakDb.toFixed(1)),
      baselineDb: Number(spike.baselineDb.toFixed(1)),
      deltaDb: Number(spike.deltaDb.toFixed(1)),
      videoOffsetSec: offsetSec,
      locationLabel: this.settings.locationLabel,
      snapshotDataUrl: snapshot,
      note: '突發巨響觸發片段',
    };
  }

  public handleSpikePeak(spike: ActiveSpikeInfo): void {
    if (!this.isRunning || !this.draftEvent || this.draftEvent.id !== spike.id) return;
    this.draftEvent.peakDb = Number(spike.peakDb.toFixed(1));
    this.draftEvent.deltaDb = Number(spike.deltaDb.toFixed(1));
    this.draftEvent.peakTimestamp = spike.peakTime;
    this.draftEvent.snapshotDataUrl = this.captureSnapshot();
  }

  public async handleSpikeEnd(completed: CompletedSpikeInfo): Promise<void> {
    if (!this.draftEvent || this.draftEvent.id !== completed.id) return;
    const event: NoiseEvent = {
      ...this.draftEvent,
      durationMs: completed.durationMs,
      peakDb: Number(completed.peakDb.toFixed(1)),
      baselineDb: Number(completed.baselineDb.toFixed(1)),
      deltaDb: Number(completed.deltaDb.toFixed(1)),
      peakTimestamp: completed.peakTime,
    };
    this.draftEvent = null;

    if (this.currentMode === 'continuous') {
      this.contEvents.push(event);
      if (event.peakDb > this.contPeakDb) {
        this.contPeakDb = event.peakDb;
      }
      await this.store.saveEvent(event);
    } else if (this.activeCapture && this.activeCapture.slot.id === event.sessionId) {
      this.activeCapture.events.push(event);
      if (event.peakDb > this.activeCapture.peakDb) {
        this.activeCapture.peakDb = event.peakDb;
      }
    }

    this.callbacks.onEventCaptured?.(event);
  }

  private startCaptureCountdown(): void {
    this.clearCaptureCountdownTimer();
    const update = (): void => {
      if (!this.activeCapture) {
        this.clearCaptureCountdownTimer();
        return;
      }
      const remain = Math.max(0, Math.ceil((this.activeCapture.postRollEndsAt - Date.now()) / 1000));
      this.callbacks.onCaptureStatusChange?.(
        `⚡ 已鎖定巨響！正在補錄後續畫面（剩餘 ${remain} 秒自動封裝）`,
        true,
      );
    };
    update();
    this.captureCountdownTimer = window.setInterval(update, 500);
  }

  private stopRecorderAndBuildBlob(
    recorder: MediaRecorder,
    chunks: Blob[],
    mimeType: string,
  ): Promise<Blob> {
    return new Promise((resolve) => {
      if (recorder.state === 'inactive') {
        resolve(new Blob(chunks, { type: mimeType }));
        return;
      }

      let resolved = false;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
      };

      const timeout = window.setTimeout(finish, 1800);
      recorder.onstop = () => {
        window.clearTimeout(timeout);
        finish();
      };
      recorder.onerror = () => {
        window.clearTimeout(timeout);
        finish();
      };

      try {
        recorder.stop();
      } catch (err) {
        window.clearTimeout(timeout);
        this.callbacks.onError?.(`停止錄影器異常: ${(err as Error).message}`);
        finish();
      }
    });
  }
}
