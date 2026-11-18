import type { AppSettings, AudioTelemetry } from '../types.ts';

export interface ActiveSpikeInfo {
  id: string;
  startTime: number;
  peakTime: number;
  lastLoudTime: number;
  peakDb: number;
  baselineDb: number;
  deltaDb: number;
}

export interface CompletedSpikeInfo {
  id: string;
  startTime: number;
  peakTime: number;
  durationMs: number;
  peakDb: number;
  baselineDb: number;
  deltaDb: number;
}

export interface SpikeDetectorCallbacks {
  onTelemetry?: (telemetry: AudioTelemetry) => void;
  onSpikeStart?: (spike: ActiveSpikeInfo) => void;
  onSpikePeak?: (spike: ActiveSpikeInfo) => void;
  onSpikeEnd?: (spike: CompletedSpikeInfo) => void;
}

export class SpikeDetector {
  private audioCtx: AudioContext | null = null;
  private mixerGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private timeData: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(2048 * 4));
  private sampleTimer: number | null = null;

  private settings: AppSettings;
  private callbacks: SpikeDetectorCallbacks;

  private baselineDb = 38;
  private sessionPeakDb = 0;
  private sampleCount = 0;
  private activeSpike: ActiveSpikeInfo | null = null;
  private lastSpikeAt = 0;
  private lastSpikePeakDb = 0;
  private lastSpikeDeltaDb = 0;
  private hasRealMic = false;

  // Envelope fallback in case a headless environment freezes AudioContext clock
  private simPulseUntil = 0;
  private simPulsePeakDb = 84;

  constructor(settings: AppSettings, callbacks: SpikeDetectorCallbacks = {}) {
    this.settings = { ...settings };
    this.callbacks = callbacks;
  }

  public updateSettings(settings: AppSettings): void {
    this.settings = { ...settings };
  }

  public isUsingRealMic(): boolean {
    return this.hasRealMic;
  }

  public resetSessionPeak(): void {
    this.sessionPeakDb = 0;
  }

  public resetSpikeState(): void {
    this.activeSpike = null;
    this.lastSpikeAt = 0;
    this.lastSpikePeakDb = 0;
    this.lastSpikeDeltaDb = 0;
    this.sessionPeakDb = 0;
    this.simPulseUntil = 0;
  }

  public async init(micStream: MediaStream | null): Promise<MediaStreamTrack | null> {
    if (!this.audioCtx) {
      const AudioCtxCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxCtor();
      this.mixerGain = this.audioCtx.createGain();
      this.mixerGain.gain.value = 1;

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.25;
      this.timeData = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

      this.audioDest = this.audioCtx.createMediaStreamDestination();
      this.mixerGain.connect(this.analyser);
      this.mixerGain.connect(this.audioDest);
    }

    await this.ensureResumed();
    this.attachMicStream(micStream);
    this.startSampling();

    return this.audioDest?.stream.getAudioTracks()[0] ?? null;
  }

  public async ensureResumed(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {
        // Ignore if autoplay policy blocks before gesture
      }
    }
  }

  private attachMicStream(micStream: MediaStream | null): void {
    if (!this.audioCtx || !this.mixerGain) return;

    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }

    const audioTracks = micStream?.getAudioTracks() ?? [];
    if (audioTracks.length > 0 && micStream) {
      this.stopAmbientBed();
      this.micSource = this.audioCtx.createMediaStreamSource(micStream);
      this.micSource.connect(this.mixerGain);
      this.hasRealMic = true;
    } else {
      this.hasRealMic = false;
      this.startAmbientBed();
    }
  }

  private startAmbientBed(): void {
    if (!this.audioCtx || !this.mixerGain || this.ambientSource) return;
    const sampleRate = this.audioCtx.sampleRate || 48000;
    const length = sampleRate * 2;
    const buffer = this.audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      data[i] = last * 0.015;
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = this.audioCtx.createGain();
    gain.gain.value = 0.85;

    source.connect(gain);
    gain.connect(this.mixerGain);
    source.start();

    this.ambientSource = source;
    this.ambientGain = gain;
  }

  private stopAmbientBed(): void {
    if (this.ambientSource) {
      try {
        this.ambientSource.stop();
      } catch {
        // Ignore already stopped
      }
      this.ambientSource.disconnect();
      this.ambientSource = null;
    }
    if (this.ambientGain) {
      this.ambientGain.disconnect();
      this.ambientGain = null;
    }
  }

  public getAudioTrack(): MediaStreamTrack | null {
    const existing = this.audioDest?.stream.getAudioTracks()[0] ?? null;
    if (existing && existing.readyState === 'live') {
      return existing;
    }
    if (this.audioCtx && this.mixerGain) {
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      this.mixerGain.connect(this.audioDest);
      return this.audioDest.stream.getAudioTracks()[0] ?? null;
    }
    return null;
  }

  public startSampling(): void {
    if (this.sampleTimer !== null) return;
    this.sampleTimer = window.setInterval(() => {
      this.processSample();
    }, 50);
  }

  public stopSampling(): void {
    if (this.sampleTimer !== null) {
      window.clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.finalizeOpenSpike(Date.now());
  }

  public finalizeOpenSpike(now = Date.now()): void {
    if (!this.activeSpike) return;
    const durationMs = Math.max(180, now - this.activeSpike.startTime);
    const completed: CompletedSpikeInfo = {
      id: this.activeSpike.id,
      startTime: this.activeSpike.startTime,
      peakTime: this.activeSpike.peakTime,
      durationMs,
      peakDb: this.activeSpike.peakDb,
      baselineDb: this.activeSpike.baselineDb,
      deltaDb: this.activeSpike.deltaDb,
    };
    this.activeSpike = null;
    this.callbacks.onSpikeEnd?.(completed);
  }

  public async triggerSimulatedSlam(targetPeakDb = 84): Promise<void> {
    if (!this.audioCtx || !this.mixerGain) {
      await this.init(null);
    }
    await this.ensureResumed();

    const nowMs = Date.now();
    this.simPulsePeakDb = Math.max(targetPeakDb, this.settings.thresholdDb + 12);
    this.simPulseUntil = nowMs + 650;

    if (this.audioCtx && this.mixerGain) {
      const ctx = this.audioCtx;
      const t0 = ctx.currentTime;

      // Low-frequency heavy door thud (145 Hz -> 34 Hz)
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(145, t0);
      osc.frequency.exponentialRampToValueAtTime(34, t0 + 0.35);

      oscGain.gain.setValueAtTime(0.001, t0);
      oscGain.gain.linearRampToValueAtTime(0.55, t0 + 0.015);
      oscGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.48);

      osc.connect(oscGain);
      oscGain.connect(this.mixerGain);
      osc.start(t0);
      osc.stop(t0 + 0.5);

      // Sharp latch impact burst
      const noiseLen = Math.floor(ctx.sampleRate * 0.28);
      const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseLen; i += 1) {
        ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.06));
      }
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, t0);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.65, t0);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);

      noiseSrc.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(this.mixerGain);
      noiseSrc.start(t0);
      noiseSrc.stop(t0 + 0.3);
    }

    // Trigger one immediate evaluation tick so UI & recorder react within <10ms
    this.processSample();
  }

  private processSample(): void {
    const now = Date.now();
    let rms = 0;

    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeData);
      let sumSquares = 0;
      for (let i = 0; i < this.timeData.length; i += 1) {
        const sample = this.timeData[i];
        sumSquares += sample * sample;
      }
      rms = Math.sqrt(sumSquares / this.timeData.length);
    }

    let currentDb = 20 * Math.log10(Math.max(rms, 1e-5)) + this.settings.calibrationOffsetDb;

    // Fallback ambient floor if browser audio context returns flat zeros without hardware mic
    if (!this.hasRealMic && rms < 1e-4) {
      currentDb = 36.5 + (Math.random() * 2.4 - 1.2);
    }

    // Apply synthetic slam envelope fallback if active
    if (now < this.simPulseUntil) {
      const remainingRatio = (this.simPulseUntil - now) / 650;
      const synthDb = this.baselineDb + (this.simPulsePeakDb - this.baselineDb) * Math.pow(remainingRatio, 0.45);
      currentDb = Math.max(currentDb, synthDb);
    }

    currentDb = Math.max(20, Math.min(120, currentDb));

    const meetsThreshold =
      currentDb >= this.settings.thresholdDb &&
      (currentDb - this.baselineDb) >= this.settings.deltaThresholdDb;

    // Update rolling 5s ambient baseline whenever current audio is NOT spiking
    if (this.sampleCount < 10) {
      this.baselineDb = this.sampleCount === 0
        ? currentDb
        : (this.baselineDb * this.sampleCount + currentDb) / (this.sampleCount + 1);
      this.sampleCount += 1;
    } else if (!this.activeSpike && !meetsThreshold) {
      this.baselineDb = this.baselineDb * 0.95 + currentDb * 0.05;
    }

    const deltaDb = currentDb - this.baselineDb;
    if (currentDb > this.sessionPeakDb) {
      this.sessionPeakDb = currentDb;
    }

    if (!this.activeSpike) {
      if (meetsThreshold) {
        this.activeSpike = {
          id: `evt_${now}_${Math.random().toString(36).slice(2, 6)}`,
          startTime: now,
          peakTime: now,
          lastLoudTime: now,
          peakDb: currentDb,
          baselineDb: this.baselineDb,
          deltaDb,
        };
        this.lastSpikeAt = now;
        this.lastSpikePeakDb = currentDb;
        this.lastSpikeDeltaDb = deltaDb;
        this.callbacks.onSpikeStart?.({ ...this.activeSpike });
        this.callbacks.onSpikePeak?.({ ...this.activeSpike });
      }
    } else {
      if (currentDb > this.activeSpike.peakDb) {
        this.activeSpike.peakDb = currentDb;
        this.activeSpike.peakTime = now;
        this.activeSpike.deltaDb = currentDb - this.activeSpike.baselineDb;
        this.lastSpikePeakDb = this.activeSpike.peakDb;
        this.lastSpikeDeltaDb = this.activeSpike.deltaDb;
        this.callbacks.onSpikePeak?.({ ...this.activeSpike });
      }

      if (meetsThreshold) {
        this.activeSpike.lastLoudTime = now;
        this.lastSpikeAt = now;
      }

      // 450ms cooldown after sound drops below threshold, plus 4000ms max single-event cap
      if (now - this.activeSpike.lastLoudTime >= 450 || now - this.activeSpike.startTime >= 4000) {
        this.finalizeOpenSpike(now);
      }
    }

    const displayDb = this.activeSpike !== null ? this.activeSpike.peakDb : currentDb;
    const displayDeltaDb = this.activeSpike !== null ? this.activeSpike.deltaDb : deltaDb;

    this.callbacks.onTelemetry?.({
      currentDb: displayDb,
      baselineDb: this.baselineDb,
      deltaDb: displayDeltaDb,
      peakDb: this.sessionPeakDb,
      isSpikeActive: this.activeSpike !== null,
      lastSpikeAt: this.lastSpikeAt,
      lastSpikePeakDb: this.lastSpikePeakDb,
      lastSpikeDeltaDb: this.lastSpikeDeltaDb,
    });
  }

  public dispose(): void {
    this.stopSampling();
    this.stopAmbientBed();
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.mixerGain = null;
    this.analyser = null;
    this.audioDest = null;
  }
}
