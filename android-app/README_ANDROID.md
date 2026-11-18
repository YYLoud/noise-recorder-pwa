# 噪音記錄器 — Android App 獨立專案資料夾 (`android-app/`)

此資料夾與根目錄的原本 Web App (PWA) **完全獨立分離**，所有 Android 原生封裝、系統防殺守護、硬體背光控制、原生檔案匯出／PDF 列印與 APK 打包設定皆集中於此。

## 目錄結構

- `噪音記錄器.apk`：已編譯並簽署完成的 Android 安裝檔，可直接傳送到手機安裝。
- `capacitor.config.json`：Capacitor 原生封裝設定 (`com.noiserecorder.evidence`)。
- `src/`：Android 版專屬前端程式碼（包含 `src/native/androidBridge.ts` 原生橋接、低電量 10% 自動存檔保護與前景通知聯動）。
- `android/`：完整 Android 原生 Gradle 專案（含 `MainActivity.java`、`NoiseNativePlugin.java`、`NoiseMonitorForegroundService.java` 與權限設定）。
- `scripts/build-apk.mjs`：本機一鍵編譯打包 APK 腳本。
- `scripts/generate-android-icons.mjs`：自動生成 Android `mipmap-*` 各解析度圖示腳本。
- `build-android.yml`：若需啟用 GitHub Actions 雲端自動打包，可將此檔複製到根目錄 `.github/workflows/build-android.yml`。

## 如何在本機重新編譯 APK

請先切換到此資料夾再執行指令：

```powershell
cd android-app
npm.cmd install
npm.cmd run android:apk
```

編譯完成後會自動更新 `android-app/噪音記錄器.apk`。

## 手機安裝與穩定運行建議

1. 將 `android-app/噪音記錄器.apk` 傳送至 Android 手機點擊安裝。
2. 首次開啟時允許「相機」、「麥克風」與「通知」權限。
3. 至 App 內的 **「📄 報告與設定」** 點擊 **「🛡 一鍵加入 Android 背景防殺白名單」**，確保夜間長時間掛機穩定不中斷。
