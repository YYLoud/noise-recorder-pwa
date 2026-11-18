import { androidBridge } from '../native/androidBridge.ts';

export interface PowerSaverCallbacks {
  onWakeLockChange?: (active: boolean, supported: boolean) => void;
  onStandbyChange?: (active: boolean) => void;
}

export class PowerSaver {
  private wakeLock: WakeLockSentinel | null = null;
  private wantWakeLock = false;
  private nativeWakeLockActive = false;
  private blackoutActive = false;
  private callbacks: PowerSaverCallbacks;
  private globalDimmerEl: HTMLElement;
  private hintBoxEl: HTMLElement | null;
  private burnInTimer: number | null = null;
  private lastTapTime = 0;

  constructor(globalDimmerEl: HTMLElement, callbacks: PowerSaverCallbacks = {}) {
    this.globalDimmerEl = globalDimmerEl;
    this.hintBoxEl = globalDimmerEl.querySelector('#standby-hint-box');
    this.callbacks = callbacks;

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.globalDimmerEl.addEventListener('click', this.handleDoubleTapWake);
  }

  public isWakeLockSupported(): boolean {
    return androidBridge.isAndroidApp() || (typeof navigator !== 'undefined' && 'wakeLock' in navigator);
  }

  public isWakeLockActive(): boolean {
    return this.nativeWakeLockActive || (this.wakeLock !== null && !this.wakeLock.released);
  }

  public async setWakeLockDesired(desired: boolean): Promise<void> {
    this.wantWakeLock = desired;
    if (androidBridge.isAndroidApp()) {
      await androidBridge.setKeepScreenOn(desired);
      this.nativeWakeLockActive = desired;
      this.callbacks.onWakeLockChange?.(desired, true);
    }

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
    if (androidBridge.isAndroidApp()) {
      await androidBridge.setKeepScreenOn(true);
      this.nativeWakeLockActive = true;
      this.callbacks.onWakeLockChange?.(true, true);
    }
    if (!('wakeLock' in navigator)) {
      return;
    }
    try {
      if (this.wakeLock && !this.wakeLock.released) {
        this.callbacks.onWakeLockChange?.(true, true);
        return;
      }
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        if (!this.nativeWakeLockActive) {
          this.callbacks.onWakeLockChange?.(false, true);
        }
      });
      this.callbacks.onWakeLockChange?.(true, true);
    } catch {
      if (!this.nativeWakeLockActive) {
        this.callbacks.onWakeLockChange?.(false, true);
      }
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (androidBridge.isAndroidApp()) {
      await androidBridge.setKeepScreenOn(false);
      this.nativeWakeLockActive = false;
    }
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
   * Pure OLED black curtain overlay without overriding the phone's system brightness.
   * Double-tap anywhere on the curtain wakes the screen immediately.
   */
  public setBlackoutStandby(active: boolean): void {
    this.blackoutActive = active;
    this.globalDimmerEl.classList.toggle('active', active);
    this.globalDimmerEl.setAttribute('aria-hidden', String(!active));
    if (active) {
      this.startBurnInShift();
    } else {
      this.stopBurnInShift();
    }
    this.callbacks.onStandbyChange?.(active);
  }

  public isBlackoutStandby(): boolean {
    return this.blackoutActive;
  }

  private startBurnInShift(): void {
    this.stopBurnInShift();
    const shift = (): void => {
      if (!this.hintBoxEl) return;
      const dx = Math.round((Math.random() - 0.5) * 32);
      const dy = Math.round((Math.random() - 0.5) * 36);
      this.hintBoxEl.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    shift();
    this.burnInTimer = window.setInterval(shift, 10_000);
  }

  private stopBurnInShift(): void {
    if (this.burnInTimer !== null) {
      window.clearInterval(this.burnInTimer);
      this.burnInTimer = null;
    }
    if (this.hintBoxEl) {
      this.hintBoxEl.style.transform = '';
    }
  }

  private handleDoubleTapWake = (): void => {
    if (!this.blackoutActive) return;
    const now = Date.now();
    if (now - this.lastTapTime < 380) {
      this.setBlackoutStandby(false);
      this.lastTapTime = 0;
    } else {
      this.lastTapTime = now;
    }
  };

  public dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.globalDimmerEl.removeEventListener('click', this.handleDoubleTapWake);
    this.stopBurnInShift();
    void this.releaseWakeLock();
  }
}
