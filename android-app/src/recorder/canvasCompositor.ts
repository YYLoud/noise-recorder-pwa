import { RESOLUTION_DIMENSIONS } from '../types.ts';
import type { AppSettings, AudioTelemetry, RecordingMode } from '../types.ts';
import { formatPreciseTimestamp } from '../utils/format.ts';

export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private videoEl: HTMLVideoElement;
  private settings: AppSettings;

  private renderTimer: number | null = null;
  private capturedStream: MediaStream | null = null;
  private capturedFps = 0;
  private isRecording = false;
  private activeMode: RecordingMode = 'continuous';
  private hasRealCamera = false;

  private telemetry: AudioTelemetry = {
    currentDb: 36,
    baselineDb: 36,
    deltaDb: 0,
    peakDb: 36,
    isSpikeActive: false,
    lastSpikeAt: 0,
    lastSpikePeakDb: 0,
    lastSpikeDeltaDb: 0,
  };

  private pendingPeakTelemetry: AudioTelemetry | null = null;
  private heldDb = 36;
  private heldDeltaDb = 0;
  private heldUntil = 0;
  private dbHistory: number[] = new Array(80).fill(36);

  constructor(canvas: HTMLCanvasElement, videoEl: HTMLVideoElement, settings: AppSettings) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('無法取得 Canvas 2D 繪圖環境');
    }
    this.ctx = context;
    this.videoEl = videoEl;
    this.settings = { ...settings };
    this.applyDimensions();
  }

  public applyDimensions(): void {
    const dims = RESOLUTION_DIMENSIONS[this.settings.resolution];
    if (this.canvas.width !== dims.width || this.canvas.height !== dims.height) {
      this.canvas.width = dims.width;
      this.canvas.height = dims.height;
    }
  }

  public updateSettings(settings: AppSettings): void {
    const fpsChanged = this.settings.fps !== settings.fps;
    const resChanged = this.settings.resolution !== settings.resolution;
    this.settings = { ...settings };
    this.activeMode = settings.recordingMode;
    if (resChanged) {
      this.applyDimensions();
    }
    if (fpsChanged) {
      this.capturedStream = null;
      if (this.renderTimer !== null) {
        this.stopLoop();
        this.startLoop();
      }
    }
  }

  public setRecordingState(isRecording: boolean, mode: RecordingMode): void {
    this.isRecording = isRecording;
    this.activeMode = mode;
    this.telemetry = {
      ...this.telemetry,
      isSpikeActive: false,
      lastSpikeAt: 0,
    };
    this.pendingPeakTelemetry = null;
    this.heldUntil = 0;
  }

  public setHasRealCamera(hasCamera: boolean): void {
    this.hasRealCamera = hasCamera;
  }

  public updateTelemetry(telemetry: AudioTelemetry): void {
    this.telemetry = telemetry;
    if (!this.pendingPeakTelemetry || telemetry.currentDb >= this.pendingPeakTelemetry.currentDb) {
      this.pendingPeakTelemetry = telemetry;
    }
    if (telemetry.isSpikeActive || telemetry.currentDb >= this.settings.thresholdDb) {
      const now = Date.now();
      if (telemetry.currentDb >= this.heldDb || now >= this.heldUntil) {
        this.heldDb = telemetry.currentDb;
        this.heldDeltaDb = telemetry.deltaDb;
        this.heldUntil = now + 260;
      }
    }
  }

  public startLoop(): void {
    if (this.renderTimer !== null) return;
    const intervalMs = Math.max(40, Math.round(1000 / Math.max(5, this.settings.fps)));
    this.drawFrame();
    // Use setInterval instead of requestAnimationFrame so rendering continues reliably in standby mode
    this.renderTimer = window.setInterval(() => {
      this.drawFrame();
    }, intervalMs);
  }

  public stopLoop(): void {
    if (this.renderTimer !== null) {
      window.clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }

  public getVideoStream(): MediaStream {
    const tracks = this.capturedStream?.getVideoTracks() ?? [];
    const hasLiveTrack = tracks.length > 0 && tracks[0].readyState === 'live';
    if (this.capturedStream && hasLiveTrack && this.capturedFps === this.settings.fps) {
      return this.capturedStream;
    }
    this.capturedFps = this.settings.fps;
    this.capturedStream = this.canvas.captureStream(this.settings.fps);
    return this.capturedStream;
  }

  public captureSnapshotDataUrl(): string {
    this.drawFrame();
    return this.canvas.toDataURL('image/jpeg', 0.82);
  }

  private drawFrame(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = w / 640; // proportional scale relative to 360p baseline
    const now = Date.now();
    const sample = this.pendingPeakTelemetry ?? this.telemetry;
    this.pendingPeakTelemetry = null;
    let displayDb = sample.currentDb;
    let displayDeltaDb = sample.deltaDb;
    if (now < this.heldUntil && this.heldDb > displayDb) {
      displayDb = this.heldDb;
      displayDeltaDb = this.heldDeltaDb;
    }

    const spikeBannerVisible = this.telemetry.isSpikeActive || sample.isSpikeActive;

    this.dbHistory.push(displayDb);
    if (this.dbHistory.length > 80) {
      this.dbHistory.shift();
    }

    // 1. Background camera feed or simulated doorway feed
    const videoReady =
      this.hasRealCamera &&
      this.videoEl.readyState >= 2 &&
      this.videoEl.videoWidth > 0 &&
      this.videoEl.videoHeight > 0;

    if (videoReady) {
      this.drawCoverVideo(w, h);
    } else {
      this.drawSimulatedScene(w, h, s, spikeBannerVisible, now);
    }

    // 2. Top evidence header overlay
    const topBarH = Math.round(54 * s);
    this.ctx.fillStyle = 'rgba(6, 10, 18, 0.74)';
    this.ctx.fillRect(0, 0, w, topBarH);

    // Status dot
    const dotX = Math.round(16 * s);
    const dotY = Math.round(16 * s);
    const pulseOn = !this.isRecording || Math.floor(now / 500) % 2 === 0;
    this.ctx.beginPath();
    this.ctx.arc(dotX, dotY, Math.max(3.5, 5.5 * s), 0, Math.PI * 2);
    this.ctx.fillStyle = this.isRecording
      ? (pulseOn ? '#ef4444' : '#7f1d1d')
      : '#22c55e';
    this.ctx.fill();

    // Top line: App name + mode + telemetry spec
    this.ctx.fillStyle = '#f8fafc';
    this.ctx.font = `700 ${Math.round(13 * s)}px system-ui, -apple-system, sans-serif`;
    const modeLabel = this.activeMode === 'continuous' ? '全程連續蒐證' : '事件觸發擷取';
    const stateText = this.isRecording ? `REC • 噪音記錄器 (${modeLabel})` : `待命監測 • 噪音記錄器 (${modeLabel})`;
    this.ctx.fillText(stateText, Math.round(28 * s), Math.round(20 * s));

    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = '#94a3b8';
    this.ctx.font = `600 ${Math.round(11 * s)}px monospace`;
    const kbps = Math.round(this.settings.videoBitrate / 1000);
    this.ctx.fillText(`${this.settings.resolution} ${this.settings.fps}fps ${kbps}k`, w - Math.round(12 * s), Math.round(19 * s));
    this.ctx.textAlign = 'left';

    // Second line: Millisecond precision timestamp + custom location tag
    const timestampStr = formatPreciseTimestamp(now);
    this.ctx.fillStyle = '#fde047';
    this.ctx.font = `700 ${Math.round(14 * s)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    this.ctx.fillText(timestampStr, Math.round(12 * s), Math.round(42 * s));

    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = '#e2e8f0';
    this.ctx.font = `600 ${Math.round(12 * s)}px system-ui, -apple-system, sans-serif`;
    const loc = this.settings.locationLabel.trim() || '未指定位置';
    this.ctx.fillText(loc.slice(0, 22), w - Math.round(12 * s), Math.round(41 * s));
    this.ctx.textAlign = 'left';

    // 3. Spike Alert Banner + Red Frame
    if (spikeBannerVisible) {
      this.ctx.strokeStyle = '#ef4444';
      this.ctx.lineWidth = Math.max(3, Math.round(5 * s));
      this.ctx.strokeRect(2, 2, w - 4, h - 4);

      const alertW = Math.round(310 * s);
      const alertH = Math.round(32 * s);
      const alertX = w - alertW - Math.round(12 * s);
      const alertY = topBarH + Math.round(10 * s);
      this.ctx.fillStyle = 'rgba(220, 38, 38, 0.92)';
      this.ctx.fillRect(alertX, alertY, alertW, alertH);

      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = `700 ${Math.round(13 * s)}px system-ui, -apple-system, sans-serif`;
      const peakVal = Math.max(displayDb, this.telemetry.lastSpikePeakDb).toFixed(1);
      const deltaVal = Math.max(0, this.telemetry.lastSpikeDeltaDb).toFixed(1);
      this.ctx.fillText(`⚠ 偵測到突發巨響！${peakVal} dB (+${deltaVal})`, alertX + Math.round(10 * s), alertY + Math.round(21 * s));
    }

    // 4. Bottom acoustic telemetry HUD + live waveform graph
    const botH = Math.round(64 * s);
    const botY = h - botH;
    this.ctx.fillStyle = 'rgba(6, 10, 18, 0.78)';
    this.ctx.fillRect(0, botY, w, botH);

    const dbColor =
      displayDb >= this.settings.thresholdDb
        ? '#ef4444'
        : displayDb >= this.settings.thresholdDb - 8
          ? '#f59e0b'
          : '#22c55e';

    this.ctx.fillStyle = dbColor;
    this.ctx.font = `800 ${Math.round(22 * s)}px ui-monospace, monospace`;
    this.ctx.fillText(`${displayDb.toFixed(1)} dB`, Math.round(12 * s), botY + Math.round(28 * s));

    this.ctx.fillStyle = '#cbd5e1';
    this.ctx.font = `500 ${Math.round(11 * s)}px ui-monospace, monospace`;
    const deltaSign = displayDeltaDb >= 0 ? '+' : '';
    this.ctx.fillText(
      `背景 ${sample.baselineDb.toFixed(1)} | 突增 ${deltaSign}${displayDeltaDb.toFixed(1)} | 峰值 ${this.telemetry.peakDb.toFixed(1)} dB`,
      Math.round(12 * s),
      botY + Math.round(50 * s),
    );

    // Horizontal dB meter bar (left-middle)
    const barX = Math.round(132 * s);
    const barY = botY + Math.round(14 * s);
    const barW = Math.round(240 * s);
    const barH = Math.round(12 * s);
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    this.ctx.fillRect(barX, barY, barW, barH);

    const normalized = Math.max(0, Math.min(1, (displayDb - 25) / 75));
    this.ctx.fillStyle = dbColor;
    this.ctx.fillRect(barX, barY, Math.round(barW * normalized), barH);

    const threshNorm = Math.max(0, Math.min(1, (this.settings.thresholdDb - 25) / 75));
    const threshX = barX + Math.round(barW * threshNorm);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(threshX - 1, barY - 2, 2, barH + 4);

    // Mini scrolling dB waveform history graph (bottom right)
    const graphW = Math.round(228 * s);
    const graphH = Math.round(46 * s);
    const graphX = w - graphW - Math.round(12 * s);
    const graphY = botY + Math.round(9 * s);

    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    this.ctx.fillRect(graphX, graphY, graphW, graphH);
    this.ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(graphX, graphY, graphW, graphH);

    // Threshold dashed line on graph
    const threshY = graphY + graphH - Math.round(graphH * threshNorm);
    this.ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    this.ctx.beginPath();
    this.ctx.moveTo(graphX, threshY);
    this.ctx.lineTo(graphX + graphW, threshY);
    this.ctx.stroke();

    // Scale labels on waveform box
    this.ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    this.ctx.font = `600 ${Math.max(8, Math.round(9 * s))}px monospace`;
    this.ctx.fillText('100', graphX + Math.round(3 * s), graphY + Math.round(10 * s));
    this.ctx.fillText('25', graphX + Math.round(3 * s), graphY + graphH - Math.round(3 * s));

    // Waveform polyline
    this.ctx.strokeStyle = '#38bdf8';
    this.ctx.lineWidth = Math.max(1.2, 1.8 * s);
    this.ctx.beginPath();
    const len = this.dbHistory.length;
    let tipX = graphX + graphW;
    let tipY = graphY + graphH;
    for (let i = 0; i < len; i += 1) {
      const valNorm = Math.max(0, Math.min(1, (this.dbHistory[i] - 25) / 75));
      const px = graphX + (i / (len - 1)) * graphW;
      const py = graphY + graphH - valNorm * graphH;
      if (i === 0) {
        this.ctx.moveTo(px, py);
      } else {
        this.ctx.lineTo(px, py);
      }
      if (i === len - 1) {
        tipX = px;
        tipY = py;
      }
    }
    this.ctx.stroke();

    // Active sample dot at rightmost tip matching current left dB readout
    this.ctx.beginPath();
    this.ctx.arc(tipX - Math.max(1.5, 2 * s), tipY, Math.max(2.2, 3 * s), 0, Math.PI * 2);
    this.ctx.fillStyle = dbColor;
    this.ctx.fill();
  }

  private drawCoverVideo(w: number, h: number): void {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    const targetRatio = w / h;
    const videoRatio = vw / vh;

    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (videoRatio > targetRatio) {
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }

    this.ctx.drawImage(this.videoEl, sx, sy, sw, sh, 0, 0, w, h);
  }

  private drawSimulatedScene(w: number, h: number, s: number, spikeActive: boolean, now: number): void {
    // Realistic low-light hallway/door monitoring placeholder when camera isn't attached
    const shakeX = spikeActive ? Math.sin(now * 0.12) * 3 * s : 0;
    const shakeY = spikeActive ? Math.cos(now * 0.15) * 2 * s : 0;

    const grad = this.ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.65, '#1e293b');
    grad.addColorStop(1, '#090d16');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, w, h);

    // Subtle corridor walls & floor lines
    this.ctx.strokeStyle = 'rgba(100, 116, 139, 0.25)';
    this.ctx.lineWidth = Math.max(1, 1.5 * s);
    this.ctx.beginPath();
    this.ctx.moveTo(0, h * 0.85);
    this.ctx.lineTo(w * 0.25, h * 0.72);
    this.ctx.lineTo(w * 0.75, h * 0.72);
    this.ctx.lineTo(w, h * 0.85);
    this.ctx.stroke();

    // Neighbor door frame silhouette in background
    const doorW = Math.round(118 * s);
    const doorH = Math.round(186 * s);
    const doorX = Math.round((w - doorW) / 2 + shakeX);
    const doorY = Math.round(h * 0.2 + shakeY);

    this.ctx.fillStyle = spikeActive ? '#331c24' : '#162032';
    this.ctx.fillRect(doorX, doorY, doorW, doorH);
    this.ctx.strokeStyle = spikeActive ? '#ef4444' : '#475569';
    this.ctx.lineWidth = Math.max(1.5, 2 * s);
    this.ctx.strokeRect(doorX, doorY, doorW, doorH);

    // Door handle
    this.ctx.fillStyle = '#94a3b8';
    this.ctx.fillRect(doorX + doorW - Math.round(18 * s), doorY + doorH * 0.52, Math.round(10 * s), Math.round(4 * s));

    // Shockwave rings when slam triggers
    if (spikeActive) {
      const ringRadius = ((now % 600) / 600) * 140 * s;
      this.ctx.strokeStyle = `rgba(239, 68, 68, ${Math.max(0.15, 0.8 - ringRadius / (160 * s))})`;
      this.ctx.lineWidth = Math.max(2, 3 * s);
      this.ctx.beginPath();
      this.ctx.arc(doorX + doorW / 2, doorY + doorH * 0.5, ringRadius, 0, Math.PI * 2);
      this.ctx.stroke();
    }

    // Center helper note
    this.ctx.fillStyle = 'rgba(226, 232, 240, 0.78)';
    this.ctx.font = `600 ${Math.round(12 * s)}px system-ui, -apple-system, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.fillText('模擬監視畫面（允許手機相機權限後將自動切換實景）', w / 2, Math.round(h * 0.79));
    this.ctx.textAlign = 'left';
  }
}
