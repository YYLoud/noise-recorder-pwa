export interface PowerSaverCallbacks {
  onWakeLockChange?: (active: boolean, supported: boolean) => void;
  onStandbyChange?: (active: boolean) => void;
  onScreenBrightnessChange?: (brightness: number) => void;
  onStandbyBrightnessChange?: (brightness: number) => void;
  onStandbyTextOpacityChange?: (opacity: number) => void;
}

export class PowerSaver {
  private wakeLock: WakeLockSentinel | null = null;
  private wantWakeLock = false;
  private isStandby = false;
  private screenBrightness = 100;
  private standbyBrightness = 15;
  private standbyTextOpacity = 50;
  private driftTimer: number | null = null;
  private callbacks: PowerSaverCallbacks;

  private globalDimmerEl: HTMLElement;
  private standbyOverlayEl: HTMLElement;
  private standbyCardEl: HTMLElement;
  private standbyContentEl: HTMLElement;

  constructor(
    globalDimmerEl: HTMLElement,
    standbyOverlayEl: HTMLElement,
    standbyCardEl: HTMLElement,
    standbyContentEl: HTMLElement,
    callbacks: PowerSaverCallbacks = {},
  ) {
    this.globalDimmerEl = globalDimmerEl;
    this.standbyOverlayEl = standbyOverlayEl;
    this.standbyCardEl = standbyCardEl;
    this.standbyContentEl = standbyContentEl;
    this.callbacks = callbacks;

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.setupStandbyDoubleTap();
  }

  public isWakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  public isWakeLockActive(): boolean {
    return this.wakeLock !== null && !this.wakeLock.released;
  }

  public isStandbyActive(): boolean {
    return this.isStandby;
  }

  public async setWakeLockDesired(desired: boolean): Promise<void> {
    this.wantWakeLock = desired;
    if (desired) {
      await this.requestWakeLock();
    } else {
      await this.releaseWakeLock();
    }
  }

  private async requestWakeLock(): Promise<void> {
    const supported = this.isWakeLockSupported();
    if (!supported) {
      this.callbacks.onWakeLockChange?.(false, false);
      return;
    }
    try {
      if (this.wakeLock && !this.wakeLock.released) {
        this.callbacks.onWakeLockChange?.(true, true);
        return;
      }
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.callbacks.onWakeLockChange?.(false, true);
      });
      this.callbacks.onWakeLockChange?.(true, true);
    } catch {
      this.callbacks.onWakeLockChange?.(false, true);
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch {
        // Ignore release errors
      }
      this.wakeLock = null;
    }
    this.callbacks.onWakeLockChange?.(false, this.isWakeLockSupported());
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.wantWakeLock) {
      void this.requestWakeLock();
    }
  };

  /**
   * Adjusts main screen brightness (0%..100%).
   * Caps global dimming opacity at 0.88 so user never accidentally blacks out UI controls outside standby.
   */
  public setScreenBrightness(brightness: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(brightness)));
    this.screenBrightness = clamped;
    const dimOpacity = ((100 - clamped) / 100) * 0.88;
    this.globalDimmerEl.style.opacity = dimOpacity.toFixed(3);
    this.callbacks.onScreenBrightnessChange?.(clamped);
  }

  /**
   * Adjusts OLED standby overlay darkness (0% = pure #000000 black, 100% = transparent preview visible).
   */
  public setStandbyBrightness(brightness: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(brightness)));
    this.standbyBrightness = clamped;
    const bgAlpha = 1 - clamped / 100;
    this.standbyOverlayEl.style.backgroundColor = `rgba(0, 0, 0, ${bgAlpha.toFixed(3)})`;
    this.callbacks.onStandbyBrightnessChange?.(clamped);
  }

  /**
   * Adjusts floating status card & standby controls opacity (10%..100%).
   */
  public setStandbyTextOpacity(opacity: number): void {
    const clamped = Math.max(10, Math.min(100, Math.round(opacity)));
    this.standbyTextOpacity = clamped;
    this.standbyContentEl.style.opacity = (clamped / 100).toFixed(2);
    this.callbacks.onStandbyTextOpacityChange?.(clamped);
  }

  public getScreenBrightness(): number {
    return this.screenBrightness;
  }

  public getStandbyBrightness(): number {
    return this.standbyBrightness;
  }

  public getStandbyTextOpacity(): number {
    return this.standbyTextOpacity;
  }

  public enterStandbyMode(): void {
    this.isStandby = true;
    this.setStandbyBrightness(this.standbyBrightness);
    this.setStandbyTextOpacity(this.standbyTextOpacity);
    this.standbyOverlayEl.hidden = false;
    this.startAntiBurnInDrift();
    this.callbacks.onStandbyChange?.(true);
  }

  public exitStandbyMode(): void {
    this.isStandby = false;
    this.standbyOverlayEl.hidden = true;
    this.stopAntiBurnInDrift();
    this.callbacks.onStandbyChange?.(false);
  }

  private setupStandbyDoubleTap(): void {
    let lastTap = 0;
    this.standbyOverlayEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('button, input, label, .standby-controls')) {
        return;
      }
      const now = Date.now();
      if (now - lastTap < 360) {
        this.exitStandbyMode();
      }
      lastTap = now;
    });
  }

  private startAntiBurnInDrift(): void {
    this.stopAntiBurnInDrift();
    const applyDrift = (): void => {
      const offsetX = Math.round((Math.random() - 0.5) * 28);
      const offsetY = Math.round((Math.random() - 0.5) * 40);
      this.standbyCardEl.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    };
    applyDrift();
    this.driftTimer = window.setInterval(applyDrift, 10_000);
  }

  private stopAntiBurnInDrift(): void {
    if (this.driftTimer !== null) {
      window.clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    this.standbyCardEl.style.transform = 'translate(0px, 0px)';
  }

  public dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.stopAntiBurnInDrift();
    void this.releaseWakeLock();
  }
}
