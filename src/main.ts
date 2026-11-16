import './style.css';
import { SpikeDetector } from './audio/spikeDetector.ts';
import { ReportExporter } from './export/reportExporter.ts';
import { PowerSaver } from './power/powerSaver.ts';
import { CanvasCompositor } from './recorder/canvasCompositor.ts';
import { RecordingManager } from './recorder/recordingManager.ts';
import { EvidenceStore } from './storage/evidenceStore.ts';
import { DEFAULT_SETTINGS, LOCATION_PRESETS, RESOLUTION_DIMENSIONS } from './types.ts';
import type {
  AppSettings,
  AudioTelemetry,
  NoiseEvent,
  RecordingMode,
  RecordingSession,
  ResolutionPreset,
} from './types.ts';
import {
  estimateMbPerMin,
  formatBytes,
  formatDateTimeShort,
  formatDuration,
  formatTimeWithMs,
  getFileExtensionForMime,
} from './utils/format.ts';
import { initSmartSliders, updateSliderFill } from './utils/smartSlider.ts';

const SETTINGS_KEY = 'noise_recorder_settings_v1';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...parsed };
    if (!merged.locationLabel || merged.locationLabel === '3F-B室 客廳朝向玄關門') {
      merged.locationLabel = DEFAULT_SETTINGS.locationLabel;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

class NoiseRecorderApp {
  private settings: AppSettings = loadSettings();
  private store = new EvidenceStore();

  private cameraPreviewEl = getEl<HTMLVideoElement>('camera-preview');
  private canvasEl = getEl<HTMLCanvasElement>('compositor-canvas');
  private reviewVideoEl = getEl<HTMLVideoElement>('review-video');

  private compositor: CanvasCompositor;
  private detector: SpikeDetector;
  private recordingManager: RecordingManager;
  private powerSaver: PowerSaver;

  private rawMediaStream: MediaStream | null = null;
  private recStartedAt: number | null = null;
  private recTimerInterval: number | null = null;
  private sessionEvents: NoiseEvent[] = [];

  private allSessions: RecordingSession[] = [];
  private allEvents: NoiseEvent[] = [];
  private selectedSessionId: string | null = null;
  private activeVideoObjectUrl: string | null = null;

  constructor() {
    this.compositor = new CanvasCompositor(this.canvasEl, this.cameraPreviewEl, this.settings);

    this.detector = new SpikeDetector(this.settings, {
      onTelemetry: (t) => this.handleTelemetry(t),
      onSpikeStart: (spike) => this.recordingManager.handleSpikeStart(spike),
      onSpikePeak: (spike) => this.recordingManager.handleSpikePeak(spike),
      onSpikeEnd: (completed) => {
        void this.recordingManager.handleSpikeEnd(completed);
      },
    });

    this.recordingManager = new RecordingManager(
      this.store,
      this.settings,
      () => this.compositor.captureSnapshotDataUrl(),
      () => this.detector.finalizeOpenSpike(),
      {
        onRecordingStateChange: (recording, mode, startedAt) =>
          this.handleRecordingStateChange(recording, mode, startedAt),
        onEventCaptured: (evt) => this.handleEventCaptured(evt),
        onSessionSaved: (session) => {
          void this.handleSessionSaved(session);
        },
        onCaptureStatusChange: (text, hasPending) => this.updateCaptureStatus(text, hasPending),
        onError: (msg) => this.showToast(msg, true),
      },
    );

    this.powerSaver = new PowerSaver(getEl('global-dimmer'), {
      onWakeLockChange: (active, supported) => this.renderWakeLockBadge(active, supported),
      onScreenBrightnessChange: (val) => {
        this.settings.screenBrightness = val;
        saveSettings(this.settings);
        this.syncScreenBrightnessInputs(val);
      },
    });

    this.bindEvents();
    initSmartSliders();
    this.syncAllControlsFromSettings();
    this.powerSaver.setScreenBrightness(this.settings.screenBrightness);
    this.renderWakeLockBadge(false, this.powerSaver.isWakeLockSupported());

    void this.initPipelines();
    void this.refreshStoredData();
  }

  private async initPipelines(): Promise<void> {
    this.compositor.startLoop();
    await this.detector.init(null);
  }

  private bindEvents(): void {
    // Tab switching
    document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        if (!target) return;
        document.querySelectorAll('.tab-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        document.querySelectorAll('.tab-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `tab-${target}`);
        });
        if (target === 'export') {
          this.renderOfficialReport();
        }
      });
    });

    // Header brightness popover
    getEl('btn-header-brightness').addEventListener('click', () => {
      const bar = getEl('quick-brightness-bar');
      bar.hidden = !bar.hidden;
    });

    // Camera / Mic controls
    getEl('btn-connect-av').addEventListener('click', () => {
      void this.connectRealCameraAndMic();
    });
    getEl('btn-switch-camera').addEventListener('click', () => {
      this.settings.facingMode = this.settings.facingMode === 'environment' ? 'user' : 'environment';
      saveSettings(this.settings);
      void this.connectRealCameraAndMic();
    });

    // Location preset dropdown & custom label
    const locSelect = getEl<HTMLSelectElement>('location-preset-select');
    const locInput = getEl<HTMLInputElement>('location-label-input');
    locSelect.addEventListener('change', () => {
      if (locSelect.value === '__custom__') {
        locInput.hidden = false;
        locInput.focus();
      } else {
        locInput.hidden = true;
        this.settings.locationLabel = locSelect.value;
        locInput.value = locSelect.value;
        saveSettings(this.settings);
        this.compositor.updateSettings(this.settings);
      }
    });
    locInput.addEventListener('input', () => {
      this.settings.locationLabel = locInput.value;
      saveSettings(this.settings);
      this.compositor.updateSettings(this.settings);
    });

    // Recording mode selector
    document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.recordingManager.isRecording()) {
          this.showToast('請先停止目前錄影再切換模式', true);
          return;
        }
        const mode = btn.dataset.mode as RecordingMode;
        this.settings.recordingMode = mode;
        saveSettings(this.settings);
        this.compositor.updateSettings(this.settings);
        this.syncModeButtons();
      });
    });

    // Main actions
    getEl('btn-toggle-record').addEventListener('click', () => {
      void this.toggleRecording();
    });
    getEl('btn-finalize-clip-now').addEventListener('click', () => {
      void this.recordingManager.finalizeActiveEventCaptureNow();
    });
    getEl('btn-simulate-slam').addEventListener('click', () => {
      void this.detector.triggerSimulatedSlam(Math.max(82, this.settings.thresholdDb + 15));
      this.showToast('已注入模擬關門巨響脈衝', false);
    });

    // Sliders: acoustic thresholds
    const threshSlider = getEl<HTMLInputElement>('threshold-db-slider');
    threshSlider.addEventListener('input', () => {
      this.settings.thresholdDb = Number(threshSlider.value);
      saveSettings(this.settings);
      this.syncThresholdDisplays();
      this.detector.updateSettings(this.settings);
      this.compositor.updateSettings(this.settings);
    });

    const deltaSlider = getEl<HTMLInputElement>('delta-db-slider');
    deltaSlider.addEventListener('input', () => {
      this.settings.deltaThresholdDb = Number(deltaSlider.value);
      saveSettings(this.settings);
      this.syncThresholdDisplays();
      this.detector.updateSettings(this.settings);
    });

    // Screen brightness sliders (synced across header, monitor tab, settings tab)
    const bindMainBrightness = (id: string): void => {
      const slider = getEl<HTMLInputElement>(id);
      slider.addEventListener('input', () => {
        const val = Number(slider.value);
        this.settings.screenBrightness = val;
        saveSettings(this.settings);
        this.powerSaver.setScreenBrightness(val);
      });
    };
    bindMainBrightness('quick-brightness-slider');
    bindMainBrightness('main-brightness-slider');
    bindMainBrightness('setting-main-brightness');

    // Video compression & calibration settings
    getEl<HTMLSelectElement>('setting-resolution').addEventListener('change', (e) => {
      this.settings.resolution = (e.target as HTMLSelectElement).value as ResolutionPreset;
      saveSettings(this.settings);
      this.compositor.updateSettings(this.settings);
    });
    getEl<HTMLSelectElement>('setting-fps').addEventListener('change', (e) => {
      this.settings.fps = Number((e.target as HTMLSelectElement).value);
      saveSettings(this.settings);
      this.compositor.updateSettings(this.settings);
    });
    getEl<HTMLSelectElement>('setting-bitrate').addEventListener('change', (e) => {
      this.settings.videoBitrate = Number((e.target as HTMLSelectElement).value);
      saveSettings(this.settings);
      this.syncEstimatedMb();
    });
    getEl<HTMLSelectElement>('setting-auto-segment').addEventListener('change', (e) => {
      this.settings.autoSegmentMinutes = Number((e.target as HTMLSelectElement).value);
      saveSettings(this.settings);
    });
    getEl<HTMLSelectElement>('setting-preroll').addEventListener('change', (e) => {
      this.settings.preRollSec = Number((e.target as HTMLSelectElement).value);
      saveSettings(this.settings);
    });
    getEl<HTMLSelectElement>('setting-postroll').addEventListener('change', (e) => {
      this.settings.postRollSec = Number((e.target as HTMLSelectElement).value);
      saveSettings(this.settings);
    });
    getEl<HTMLInputElement>('setting-calibration').addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.settings.calibrationOffsetDb = val;
      getEl('setting-calibration-val').textContent = `+${val} dB`;
      saveSettings(this.settings);
      this.detector.updateSettings(this.settings);
    });

    // Review player actions
    getEl('btn-download-video').addEventListener('click', () => {
      this.downloadSelectedSession();
    });
    getEl('btn-delete-session').addEventListener('click', () => {
      void this.deleteSelectedSession();
    });

    // Export & danger zone
    getEl('btn-export-csv').addEventListener('click', () => {
      if (this.allEvents.length === 0) {
        this.showToast('目前尚無巨響事件可匯出', true);
        return;
      }
      ReportExporter.exportCSV(this.allEvents, this.allSessions);
      this.showToast('已匯出 CSV 蒐證明細表', false);
    });
    getEl('btn-export-json').addEventListener('click', () => {
      ReportExporter.exportJSON(this.allEvents, this.allSessions);
      this.showToast('已匯出 JSON 原始資料', false);
    });
    getEl('btn-refresh-report').addEventListener('click', () => {
      this.renderOfficialReport();
      this.showToast('已更新正式蒐證報告預覽', false);
    });
    getEl('btn-print-pdf').addEventListener('click', () => {
      this.renderOfficialReport();
      window.print();
    });
    getEl('btn-clear-all').addEventListener('click', () => {
      void this.clearDatabase();
    });
  }

  private async connectRealCameraAndMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showToast('此瀏覽器不支援相機存取（需使用 HTTPS 安全連線）', true);
      return;
    }

    const dims = RESOLUTION_DIMENSIONS[this.settings.resolution];
    try {
      if (this.rawMediaStream) {
        this.rawMediaStream.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.settings.facingMode },
          width: { ideal: dims.width },
          height: { ideal: dims.height },
          frameRate: { ideal: this.settings.fps, max: 20 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.rawMediaStream = stream;
      this.cameraPreviewEl.srcObject = stream;
      await this.cameraPreviewEl.play().catch(() => {});
      this.compositor.setHasRealCamera(stream.getVideoTracks().length > 0);
      await this.detector.init(stream);

      getEl('av-source-badge').textContent = '目前：實體手機相機＋無降噪麥克風';
      this.showToast('已啟用手機相機與原生未降噪麥克風', false);
    } catch (err) {
      this.compositor.setHasRealCamera(false);
      await this.detector.init(null);
      getEl('av-source-badge').textContent = '目前：模擬監視訊號（未取得實體相機權限）';
      this.showToast(`無法開啟實體相機，已維持模擬監測模式：${(err as Error).message}`, true);
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.recordingManager.isRecording()) {
      await this.recordingManager.stop();
      await this.powerSaver.setWakeLockDesired(false);
      return;
    }

    await this.detector.ensureResumed();
    this.detector.resetSessionPeak();
    this.sessionEvents = [];
    this.renderLiveEventsFeed();

    const canvasStream = this.compositor.getVideoStream();
    const audioTrack = this.detector.getAudioTrack();
    const combinedTracks = [...canvasStream.getVideoTracks()];
    if (audioTrack) {
      combinedTracks.push(audioTrack);
    }
    const mixedStream = new MediaStream(combinedTracks);

    await this.powerSaver.setWakeLockDesired(true);
    await this.recordingManager.start(mixedStream, this.settings);
  }

  private handleRecordingStateChange(recording: boolean, _mode: RecordingMode, startedAt: number | null): void {
    this.compositor.setRecordingState(recording, _mode);
    const toggleBtn = getEl<HTMLButtonElement>('btn-toggle-record');
    const timerPill = getEl('rec-timer-pill');

    if (recording) {
      this.recStartedAt = startedAt ?? Date.now();
      toggleBtn.textContent = '⏹ 停止並保存錄影';
      toggleBtn.classList.add('recording-active');
      timerPill.hidden = false;
      this.startRecTimerLoop();
    } else {
      this.recStartedAt = null;
      toggleBtn.textContent = '🔴 開始蒐證錄影';
      toggleBtn.classList.remove('recording-active');
      timerPill.hidden = true;
      this.stopRecTimerLoop();
    }
  }

  private startRecTimerLoop(): void {
    this.stopRecTimerLoop();
    const tick = (): void => {
      if (!this.recStartedAt) return;
      const elapsed = Math.floor((Date.now() - this.recStartedAt) / 1000);
      getEl('rec-timer-pill').textContent = `● REC ${formatDuration(elapsed)}`;
    };
    tick();
    this.recTimerInterval = window.setInterval(tick, 500);
  }

  private stopRecTimerLoop(): void {
    if (this.recTimerInterval !== null) {
      window.clearInterval(this.recTimerInterval);
      this.recTimerInterval = null;
    }
  }

  private handleTelemetry(t: AudioTelemetry): void {
    this.compositor.updateTelemetry(t);

    getEl('val-current-db').textContent = `${t.currentDb.toFixed(1)} dB`;
    getEl('val-baseline-db').textContent = `${t.baselineDb.toFixed(1)} dB`;
    const sign = t.deltaDb >= 0 ? '+' : '';
    getEl('val-delta-db').textContent = `${sign}${t.deltaDb.toFixed(1)} dB`;
    getEl('val-peak-db').textContent = `${t.peakDb.toFixed(1)} dB`;

    const pct = Math.max(2, Math.min(100, ((t.currentDb - 25) / 75) * 100));
    const fillEl = getEl('live-db-bar');
    fillEl.style.width = `${pct.toFixed(1)}%`;
    fillEl.style.backgroundColor =
      t.currentDb >= this.settings.thresholdDb
        ? '#ef4444'
        : t.currentDb >= this.settings.thresholdDb - 8
          ? '#f59e0b'
          : '#22c55e';

    const spikeBadge = getEl('spike-indicator');
    if (t.isSpikeActive) {
      spikeBadge.className = 'pill pill-danger';
      spikeBadge.textContent = `⚠ 偵測到巨響！${t.currentDb.toFixed(1)} dB`;
    } else {
      spikeBadge.className = 'pill pill-ok';
      spikeBadge.textContent = '監測中・環境平穩';
    }
  }

  private updateCaptureStatus(text: string, hasPending: boolean): void {
    getEl('capture-status-text').textContent = text;
    getEl('btn-finalize-clip-now').hidden = !hasPending;
  }

  private handleEventCaptured(evt: NoiseEvent): void {
    this.sessionEvents.unshift(evt);
    this.renderLiveEventsFeed();
    this.showToast(`⚠ 已標記突發巨響：${evt.peakDb.toFixed(1)} dB (+${evt.deltaDb.toFixed(1)} dB)`, true);
    void this.refreshStoredData();
  }

  private async handleSessionSaved(session: RecordingSession): Promise<void> {
    this.showToast(
      `已保存證據影片 (${formatDuration(session.durationSec)} / ${formatBytes(session.fileSize)})`,
      false,
    );
    await this.refreshStoredData(session.id);
  }

  private async refreshStoredData(autoSelectSessionId?: string): Promise<void> {
    const [sessions, events, stats] = await Promise.all([
      this.store.getSessions(),
      this.store.getAllEvents(),
      this.store.getStorageStats(),
    ]);

    this.allSessions = sessions;
    this.allEvents = events;

    getEl('badge-storage').textContent = `已存 ${stats.sessionCount} 筆 (${formatBytes(stats.totalBytes)})`;
    getEl('tab-event-count').textContent = String(stats.eventCount);
    getEl('sessions-count-label').textContent = `${sessions.length} 筆`;
    getEl('events-count-label').textContent = `${events.length} 筆`;

    if (autoSelectSessionId) {
      this.selectedSessionId = autoSelectSessionId;
    } else if (this.selectedSessionId && !sessions.some((s) => s.id === this.selectedSessionId)) {
      this.selectedSessionId = null;
    }

    if (!this.selectedSessionId && sessions.length > 0) {
      this.loadSessionIntoPlayer(sessions[0], 0, false);
    } else if (this.selectedSessionId) {
      const current = sessions.find((s) => s.id === this.selectedSessionId);
      if (current) {
        this.renderTimelineMarkers(current);
      }
    } else {
      this.clearPlayer();
    }

    this.renderSessionsList();
    this.renderEventsList();
    this.renderOfficialReport();
  }

  private renderLiveEventsFeed(): void {
    const container = getEl('live-events-feed');
    getEl('live-event-count-label').textContent = `${this.sessionEvents.length} 次巨響`;

    if (this.sessionEvents.length === 0) {
      container.innerHTML = '<p class="empty-hint">錄影中若偵測到突發巨響，時間點與現場截圖將即時列於此處。</p>';
      return;
    }

    container.innerHTML = '';
    for (const evt of this.sessionEvents) {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML = `
        <img src="${evt.snapshotDataUrl}" alt="浮水印截圖" class="event-thumb" />
        <div class="row-main">
          <div class="row-title">⚠ ${evt.peakDb.toFixed(1)} dB (+${evt.deltaDb.toFixed(1)} dB)</div>
          <div class="row-sub">${formatTimeWithMs(evt.timestamp)} ｜ 持續 ${(evt.durationMs / 1000).toFixed(2)} 秒 ｜ 影片 ${evt.videoOffsetSec.toFixed(1)}s 處</div>
        </div>
      `;
      container.appendChild(row);
    }
  }

  private renderSessionsList(): void {
    const container = getEl('sessions-list');
    if (this.allSessions.length === 0) {
      container.innerHTML = '<p class="empty-hint">尚無錄影紀錄。請回到「蒐證錄影」進行錄製。</p>';
      return;
    }

    container.innerHTML = '';
    for (const session of this.allSessions) {
      const row = document.createElement('div');
      row.className = `session-row${session.id === this.selectedSessionId ? ' selected' : ''}`;
      const modeBadge = session.mode === 'event' ? '事件觸發' : '全程連續';
      const ext = getFileExtensionForMime(session.mimeType).toUpperCase();
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">[${modeBadge}] ${formatDateTimeShort(session.startTime)}</div>
          <div class="row-sub">
            時長 ${formatDuration(session.durationSec)} ｜ 檔案 ${formatBytes(session.fileSize)} (${ext}) ｜ ${session.resolution} ${session.fps}fps ｜ 巨響 ${session.eventCount} 次
          </div>
        </div>
        <div class="row-actions">
          <button type="button" class="btn btn-sm btn-secondary btn-load-session">▶ 載入播放</button>
        </div>
      `;
      row.querySelector('.btn-load-session')?.addEventListener('click', () => {
        this.loadSessionIntoPlayer(session, 0, true);
        this.renderSessionsList();
      });
      container.appendChild(row);
    }
  }

  private renderEventsList(): void {
    const container = getEl('events-list');
    if (this.allEvents.length === 0) {
      container.innerHTML = '<p class="empty-hint">尚無偵測到的巨響事件。</p>';
      return;
    }

    container.innerHTML = '';
    for (const evt of this.allEvents) {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML = `
        <img src="${evt.snapshotDataUrl}" alt="浮水印截圖" class="event-thumb" />
        <div class="row-main">
          <div class="row-title">🔊 ${evt.peakDb.toFixed(1)} dB (突增 +${evt.deltaDb.toFixed(1)} dB)</div>
          <div class="row-sub">
            ${formatDateTimeShort(evt.timestamp)} ｜ 持續 ${(evt.durationMs / 1000).toFixed(2)}s ｜ 影片 ${evt.videoOffsetSec.toFixed(1)}s
          </div>
        </div>
        <div class="row-actions">
          <button type="button" class="btn btn-sm btn-primary btn-jump-event">▶ 跳轉至巨響前 3 秒</button>
          <button type="button" class="btn btn-sm btn-dark btn-del-event">刪除</button>
        </div>
      `;
      row.querySelector('.btn-jump-event')?.addEventListener('click', () => {
        const session = this.allSessions.find((s) => s.id === evt.sessionId);
        if (!session) {
          this.showToast('找不到對應的錄影檔案（可能已刪除）', true);
          return;
        }
        const seekTo = Math.max(0, evt.videoOffsetSec - 3);
        this.loadSessionIntoPlayer(session, seekTo, true);
        this.renderSessionsList();
        this.showToast(`已跳轉至巨響前 3 秒（${seekTo.toFixed(1)}s）`, false);
      });
      row.querySelector('.btn-del-event')?.addEventListener('click', () => {
        void this.store.deleteEvent(evt.id).then(() => this.refreshStoredData());
      });
      container.appendChild(row);
    }
  }

  private loadSessionIntoPlayer(session: RecordingSession, seekSec: number, autoPlay: boolean): void {
    const isSameSession = this.selectedSessionId === session.id && this.reviewVideoEl.src !== '';
    this.selectedSessionId = session.id;

    const modeName = session.mode === 'event' ? '事件觸發片段' : '全程連續錄影';
    getEl('player-session-meta').textContent =
      `${modeName}・${formatDateTimeShort(session.startTime)}・${formatBytes(session.fileSize)}`;
    getEl<HTMLButtonElement>('btn-download-video').disabled = false;
    getEl<HTMLButtonElement>('btn-delete-session').disabled = false;
    this.renderTimelineMarkers(session);

    const applySeekAndPlay = (): void => {
      try {
        this.reviewVideoEl.currentTime = Math.max(0, seekSec);
      } catch {
        // Ignore seek out-of-range
      }
      if (autoPlay) {
        void this.reviewVideoEl.play().catch(() => {});
      }
    };

    if (isSameSession && this.reviewVideoEl.readyState >= 1) {
      applySeekAndPlay();
      return;
    }

    if (this.activeVideoObjectUrl) {
      URL.revokeObjectURL(this.activeVideoObjectUrl);
    }
    this.activeVideoObjectUrl = URL.createObjectURL(session.videoBlob);
    this.reviewVideoEl.src = this.activeVideoObjectUrl;
    this.reviewVideoEl.addEventListener('loadedmetadata', applySeekAndPlay, { once: true });
  }

  private renderTimelineMarkers(session: RecordingSession): void {
    const track = getEl('timeline-track');
    const sessionEvts = this.allEvents.filter((e) => e.sessionId === session.id);
    getEl('timeline-markers-count').textContent = `${sessionEvts.length} 個標記`;

    if (sessionEvts.length === 0) {
      track.innerHTML = '<div class="timeline-empty">此錄影檔案無標記之突發巨響事件</div>';
      return;
    }

    track.innerHTML = '';
    const dur = Math.max(1, session.durationSec);
    for (const evt of sessionEvts) {
      const pct = Math.max(2, Math.min(98, (evt.videoOffsetSec / dur) * 100));
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'timeline-pin';
      pin.style.left = `${pct.toFixed(1)}%`;
      pin.title = `${evt.peakDb.toFixed(1)} dB (${evt.videoOffsetSec.toFixed(1)}s) - 點擊跳轉前3秒`;
      pin.addEventListener('click', () => {
        const seekTo = Math.max(0, evt.videoOffsetSec - 3);
        this.loadSessionIntoPlayer(session, seekTo, true);
      });
      track.appendChild(pin);
    }
  }

  private clearPlayer(): void {
    this.selectedSessionId = null;
    if (this.activeVideoObjectUrl) {
      URL.revokeObjectURL(this.activeVideoObjectUrl);
      this.activeVideoObjectUrl = null;
    }
    this.reviewVideoEl.removeAttribute('src');
    this.reviewVideoEl.load();
    getEl('player-session-meta').textContent = '尚未選擇場次';
    getEl('timeline-markers-count').textContent = '0 個標記';
    getEl('timeline-track').innerHTML = '<div class="timeline-empty">選擇影片後將顯示巨響標記位置</div>';
    getEl<HTMLButtonElement>('btn-download-video').disabled = true;
    getEl<HTMLButtonElement>('btn-delete-session').disabled = true;
  }

  private downloadSelectedSession(): void {
    const session = this.allSessions.find((s) => s.id === this.selectedSessionId);
    if (!session) return;
    const ext = getFileExtensionForMime(session.mimeType);
    const url = URL.createObjectURL(session.videoBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `噪音記錄器_${session.id}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.showToast(`正在下載證據影片 (${formatBytes(session.fileSize)})`, false);
  }

  private async deleteSelectedSession(): Promise<void> {
    if (!this.selectedSessionId) return;
    const targetId = this.selectedSessionId;
    await this.store.deleteSession(targetId);
    this.selectedSessionId = null;
    this.showToast('已刪除該場次影片與相關事件', false);
    await this.refreshStoredData();
  }

  private async clearDatabase(): Promise<void> {
    await this.store.clearAll();
    this.sessionEvents = [];
    this.renderLiveEventsFeed();
    this.clearPlayer();
    await this.refreshStoredData();
    this.showToast('已清空本機所有錄影與事件紀錄', false);
  }

  private renderOfficialReport(): void {
    const container = getEl('printable-report-container');
    container.innerHTML = ReportExporter.buildPrintableReportHtml(
      this.allEvents,
      this.allSessions,
      this.settings,
    );
  }

  private renderWakeLockBadge(active: boolean, supported: boolean): void {
    const badge = getEl('badge-wakelock');
    if (!supported) {
      badge.className = 'pill pill-muted';
      badge.textContent = '防休眠：瀏覽器不支援';
    } else if (active) {
      badge.className = 'pill pill-ok';
      badge.textContent = '🔒 防休眠鎖定中';
    } else {
      badge.className = 'pill pill-muted';
      badge.textContent = '🔓 螢幕鎖定：待命';
    }
  }

  private syncAllControlsFromSettings(): void {
    this.syncLocationControls();
    getEl<HTMLInputElement>('threshold-db-slider').value = String(this.settings.thresholdDb);
    getEl<HTMLInputElement>('delta-db-slider').value = String(this.settings.deltaThresholdDb);

    getEl<HTMLSelectElement>('setting-resolution').value = this.settings.resolution;
    getEl<HTMLSelectElement>('setting-fps').value = String(this.settings.fps);
    getEl<HTMLSelectElement>('setting-bitrate').value = String(this.settings.videoBitrate);
    getEl<HTMLSelectElement>('setting-auto-segment').value = String(this.settings.autoSegmentMinutes);
    getEl<HTMLSelectElement>('setting-preroll').value = String(this.settings.preRollSec);
    getEl<HTMLSelectElement>('setting-postroll').value = String(this.settings.postRollSec);
    getEl<HTMLInputElement>('setting-calibration').value = String(this.settings.calibrationOffsetDb);
    getEl('setting-calibration-val').textContent = `+${this.settings.calibrationOffsetDb} dB`;

    this.syncModeButtons();
    this.syncThresholdDisplays();
    this.syncEstimatedMb();
    this.syncScreenBrightnessInputs(this.settings.screenBrightness);
    document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateSliderFill);
  }

  private syncLocationControls(): void {
    const locSelect = getEl<HTMLSelectElement>('location-preset-select');
    const locInput = getEl<HTMLInputElement>('location-label-input');
    const isPreset = (LOCATION_PRESETS as readonly string[]).includes(this.settings.locationLabel);
    if (isPreset) {
      locSelect.value = this.settings.locationLabel;
      locInput.hidden = true;
      locInput.value = this.settings.locationLabel;
    } else {
      locSelect.value = '__custom__';
      locInput.hidden = false;
      locInput.value = this.settings.locationLabel;
    }
  }

  private syncModeButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === this.settings.recordingMode);
    });
  }

  private syncThresholdDisplays(): void {
    getEl('threshold-db-val').textContent = `${this.settings.thresholdDb} dB`;
    getEl('delta-db-val').textContent = `+${this.settings.deltaThresholdDb} dB`;
    const pct = Math.max(0, Math.min(100, ((this.settings.thresholdDb - 25) / 75) * 100));
    getEl('live-threshold-marker').style.left = `${pct.toFixed(1)}%`;
  }

  private syncEstimatedMb(): void {
    const est = estimateMbPerMin(this.settings.videoBitrate, this.settings.audioBitrate);
    document.querySelectorAll('.est-mb-label').forEach((el) => {
      el.textContent = est;
    });
  }

  private syncScreenBrightnessInputs(val: number): void {
    const ids = ['quick-brightness-slider', 'main-brightness-slider', 'setting-main-brightness'];
    for (const id of ids) {
      const el = getEl<HTMLInputElement>(id);
      el.value = String(val);
      updateSliderFill(el);
    }
    getEl('header-brightness-label').textContent = `${val}%`;
    getEl('quick-brightness-val').textContent = `${val}%`;
    getEl('main-brightness-val').textContent = `${val}%`;
    getEl('setting-main-brightness-val').textContent = `${val}%`;
  }

  private showToast(message: string, isAlert: boolean): void {
    const container = getEl('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast${isAlert ? ' toast-alert' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 3600);
  }
}

new NoiseRecorderApp();
