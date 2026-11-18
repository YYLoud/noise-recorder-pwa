export interface NativePermissionStatus {
  camera: boolean;
  audio: boolean;
  notifications: boolean;
}

export interface NativeBatteryStatus {
  level: number;
  isCharging: boolean;
  ignoringBatteryOptimizations: boolean;
}

interface NoiseNativePluginInterface {
  ensurePermissions(): Promise<NativePermissionStatus>;
  startForegroundProtection(opts: { title: string; body: string }): Promise<{ started: boolean }>;
  updateForegroundNotification(opts: { title: string; body: string }): Promise<void>;
  stopForegroundProtection(): Promise<void>;
  setKeepScreenOn(opts: { enabled: boolean }): Promise<void>;
  setWindowBrightness(opts: { brightness: number }): Promise<void>;
  saveOrShareFile(opts: {
    filename: string;
    mimeType: string;
    base64Data: string;
    share: boolean;
  }): Promise<{ savedPath: string; shared: boolean }>;
  printReport(opts: { html: string; jobName: string }): Promise<void>;
  getBatteryStatus(): Promise<NativeBatteryStatus>;
  requestIgnoreBatteryOptimization(): Promise<{ ignoringBatteryOptimizations: boolean }>;
}

interface CapacitorRuntime {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: <T = unknown>(pluginName: string, methodName: string, options?: unknown) => Promise<T>;
  Plugins?: Record<string, unknown>;
}

interface NavigatorBatteryManager {
  level: number;
  charging: boolean;
}

function getCapacitor(): CapacitorRuntime | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorRuntime }).Capacitor;
}

async function callNative<K extends keyof NoiseNativePluginInterface>(
  method: K,
  ...args: Parameters<NoiseNativePluginInterface[K]>
): Promise<Awaited<ReturnType<NoiseNativePluginInterface[K]>>> {
  const cap = getCapacitor();
  if (!cap?.nativePromise) {
    throw new Error('Capacitor native bridge unavailable');
  }
  const options = args[0] ?? {};
  return cap.nativePromise('NoiseNative', method, options) as Promise<
    Awaited<ReturnType<NoiseNativePluginInterface[K]>>
  >;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('無法讀取檔案內容'));
    reader.readAsDataURL(blob);
  });
}

class AndroidBridge {
  public isAndroidApp(): boolean {
    const cap = getCapacitor();
    return Boolean(cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'android');
  }

  public async ensureMediaPermissions(): Promise<NativePermissionStatus> {
    if (!this.isAndroidApp()) {
      return { camera: true, audio: true, notifications: true };
    }
    return callNative('ensurePermissions');
  }

  public async startForegroundProtection(title: string, body: string): Promise<boolean> {
    if (!this.isAndroidApp()) return false;
    try {
      const res = await callNative('startForegroundProtection', { title, body });
      return Boolean(res?.started);
    } catch {
      return false;
    }
  }

  public async updateForegroundNotification(title: string, body: string): Promise<void> {
    if (!this.isAndroidApp()) return;
    try {
      await callNative('updateForegroundNotification', { title, body });
    } catch {
      // Ignore transient notification update errors
    }
  }

  public async stopForegroundProtection(): Promise<void> {
    if (!this.isAndroidApp()) return;
    try {
      await callNative('stopForegroundProtection');
    } catch {
      // Ignore stop errors
    }
  }

  public async setKeepScreenOn(enabled: boolean): Promise<void> {
    if (!this.isAndroidApp()) return;
    try {
      await callNative('setKeepScreenOn', { enabled });
    } catch {
      // Ignore
    }
  }

  public async setWindowBrightness(brightnessPct: number): Promise<void> {
    if (!this.isAndroidApp()) return;
    const clamped = Math.max(0, Math.min(100, Math.round(brightnessPct)));
    const brightness = clamped >= 100 ? -1 : Math.max(0.01, Number((clamped / 100).toFixed(3)));
    try {
      await callNative('setWindowBrightness', { brightness });
    } catch {
      // Ignore
    }
  }

  public async saveOrShareFile(
    blob: Blob,
    filename: string,
    mimeType: string,
    share = false,
  ): Promise<{ savedPath: string; shared: boolean }> {
    const base64Data = await blobToBase64(blob);
    return callNative('saveOrShareFile', {
      filename,
      mimeType,
      base64Data,
      share,
    });
  }

  public async printHtmlAsPdf(html: string, jobName: string): Promise<void> {
    if (!this.isAndroidApp()) {
      window.print();
      return;
    }
    await callNative('printReport', { html, jobName });
  }

  public async getBatteryStatus(): Promise<NativeBatteryStatus> {
    if (this.isAndroidApp()) {
      try {
        return await callNative('getBatteryStatus');
      } catch {
        return { level: 100, isCharging: true, ignoringBatteryOptimizations: false };
      }
    }

    const nav = navigator as Navigator & { getBattery?: () => Promise<NavigatorBatteryManager> };
    if (typeof nav.getBattery === 'function') {
      try {
        const bm = await nav.getBattery();
        return {
          level: Math.round(bm.level * 100),
          isCharging: Boolean(bm.charging),
          ignoringBatteryOptimizations: true,
        };
      } catch {
        // Fallback below
      }
    }
    return { level: 100, isCharging: true, ignoringBatteryOptimizations: true };
  }

  public async requestIgnoreBatteryOptimization(): Promise<boolean> {
    if (!this.isAndroidApp()) return true;
    try {
      const res = await callNative('requestIgnoreBatteryOptimization');
      return Boolean(res?.ignoringBatteryOptimizations);
    } catch {
      return false;
    }
  }
}

export const androidBridge = new AndroidBridge();
