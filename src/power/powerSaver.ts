export interface PowerSaverCallbacks {
  onWakeLockChange?: (active: boolean, supported: boolean) => void;
  onScreenBrightnessChange?: (brightness: number) => void;
}

export class PowerSaver {
  private wakeLock: WakeLockSentinel | null = null;
  private wantWakeLock = false;
  private screenBrightness = 100;
  private callbacks: PowerSaverCallbacks;
  private globalDimmerEl: HTMLElement;
  private lastTapTime = 0;

  constructor(globalDimmerEl: HTMLElement, callbacks: PowerSaverCallbacks = {}) {
    this.globalDimmerEl = globalDimmerEl;
    this.callbacks = callbacks;

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    document.addEventListener('click', this.handleDoubleTapRestore);
  }

  public isWakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  public isWakeLockActive(): boolean {
    return this.wakeLock !== null && !this.wakeLock.released;
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
   * Adjusts screen brightness (0%..100%) via global dimmer overlay.
   * Caps opacity at 0.94 so OLED screens save maximum power while double-tap always restores 100%.
   */
  public setScreenBrightness(brightness: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(brightness)));
    this.screenBrightness = clamped;
    const dimOpacity = ((100 - clamped) / 100) * 0.94;
    this.globalDimmerEl.style.opacity = dimOpacity.toFixed(3);
    this.callbacks.onScreenBrightnessChange?.(clamped);
  }

  public getScreenBrightness(): number {
    return this.screenBrightness;
  }

  private handleDoubleTapRestore = (e: MouseEvent): void => {
    if (this.screenBrightness >= 15) return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, select, label')) {
      return;
    }
    const now = Date.now();
    if (now - this.lastTapTime < 360) {
      this.setScreenBrightness(100);
      this.lastTapTime = 0;
    } else {
      this.lastTapTime = now;
    }
  };

  public dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.removeEventListener('click', this.handleDoubleTapRestore);
    void this.releaseWakeLock();
  }
}
