package com.noiserecorder.evidence;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "NoiseNative",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "audio", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NoiseNativePlugin extends Plugin {

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private WebView activePrintWebView;

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        boolean hasCamera = getPermissionState("camera") == PermissionState.GRANTED;
        boolean hasAudio = getPermissionState("audio") == PermissionState.GRANTED;
        boolean hasNotif = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;

        if (hasCamera && hasAudio && hasNotif) {
            resolvePermissionStatus(call);
            return;
        }

        List<String> aliases = new ArrayList<>();
        aliases.add("camera");
        aliases.add("audio");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            aliases.add("notifications");
        }
        requestPermissionForAliases(aliases.toArray(new String[0]), call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        resolvePermissionStatus(call);
    }

    private void resolvePermissionStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
        ret.put("audio", getPermissionState("audio") == PermissionState.GRANTED);
        boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
        ret.put("notifications", notifGranted);
        call.resolve(ret);
    }

    @PluginMethod
    public void startForegroundProtection(PluginCall call) {
        String title = call.getString("title", "🔴 噪音記錄器・正在蒐證監測中");
        String body = call.getString("body", "低功耗防休眠與 10% 低電量保護已啟動");

        setWindowKeepScreenOn(true);
        try {
            NoiseMonitorForegroundService.start(getContext(), title, body);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception ex) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", ex.getMessage());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void updateForegroundNotification(PluginCall call) {
        String title = call.getString("title", "🔴 噪音記錄器・正在蒐證監測中");
        String body = call.getString("body", "蒐證監測進行中");
        NoiseMonitorForegroundService.update(getContext(), title, body);
        call.resolve();
    }

    @PluginMethod
    public void stopForegroundProtection(PluginCall call) {
        NoiseMonitorForegroundService.stop(getContext());
        setWindowKeepScreenOn(false);
        call.resolve();
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        setWindowKeepScreenOn(enabled);
        call.resolve();
    }

    private void setWindowKeepScreenOn(boolean enabled) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (window == null) return;
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    @PluginMethod
    public void setWindowBrightness(PluginCall call) {
        Double val = call.getDouble("brightness", -1.0);
        final float brightness = val != null ? val.floatValue() : -1.0f;
        if (getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (window == null) return;
            WindowManager.LayoutParams lp = window.getAttributes();
            if (brightness < 0) {
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            } else {
                lp.screenBrightness = Math.max(0.01f, Math.min(1.0f, brightness));
            }
            window.setAttributes(lp);
        });
        call.resolve();
    }

    @PluginMethod
    public void saveOrShareFile(PluginCall call) {
        String rawFilename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String base64Data = call.getString("base64Data");
        boolean share = Boolean.TRUE.equals(call.getBoolean("share", false));

        if (rawFilename == null || rawFilename.isEmpty() || base64Data == null) {
            call.reject("缺少檔案名稱或檔案內容");
            return;
        }

        final String safeFilename = rawFilename.replaceAll("[\\\\/:*?\"<>|]", "_");

        ioExecutor.execute(() -> {
            try {
                String cleanBase64 = base64Data;
                int commaIdx = cleanBase64.indexOf(',');
                if (commaIdx >= 0) {
                    cleanBase64 = cleanBase64.substring(commaIdx + 1);
                }
                byte[] bytes = Base64.decode(cleanBase64, Base64.DEFAULT);

                String savedPath = saveToDownloads(bytes, safeFilename, mimeType);
                boolean shared = false;

                if (share) {
                    shared = launchShareSheet(bytes, safeFilename, mimeType);
                }

                JSObject ret = new JSObject();
                ret.put("savedPath", savedPath);
                ret.put("shared", shared);
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("保存檔案失敗: " + ex.getMessage(), ex);
            }
        });
    }

    private String saveToDownloads(byte[] bytes, String filename, String mimeType) throws IOException {
        Context context = getContext();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NoiseRecorder");
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("無法建立系統下載檔案項目");
            }
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) {
                    throw new IOException("無法開啟系統下載寫入串流");
                }
                out.write(bytes);
                out.flush();
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return "Download/NoiseRecorder/" + filename;
        }

        File targetDir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "NoiseRecorder"
        );
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            targetDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        }
        if (targetDir == null) {
            targetDir = new File(context.getFilesDir(), "NoiseRecorder");
        }
        if (!targetDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            targetDir.mkdirs();
        }
        File outFile = new File(targetDir, filename);
        try (FileOutputStream fos = new FileOutputStream(outFile)) {
            fos.write(bytes);
            fos.flush();
        }
        return outFile.getAbsolutePath();
    }

    private boolean launchShareSheet(byte[] bytes, String filename, String mimeType) throws IOException {
        if (getActivity() == null) return false;
        Context context = getContext();
        File shareDir = new File(context.getCacheDir(), "shared");
        if (!shareDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            shareDir.mkdirs();
        }
        File shareFile = new File(shareDir, filename);
        try (FileOutputStream fos = new FileOutputStream(shareFile)) {
            fos.write(bytes);
            fos.flush();
        }

        Uri contentUri = FileProvider.getUriForFile(
            context,
            context.getPackageName() + ".fileprovider",
            shareFile
        );

        getActivity().runOnUiThread(() -> {
            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType(mimeType);
            shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, "噪音記錄器蒐證證據：" + filename);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(shareIntent, "分享噪音蒐證檔案");
            getActivity().startActivity(chooser);
        });
        return true;
    }

    @PluginMethod
    @SuppressLint("SetJavaScriptEnabled")
    public void printReport(PluginCall call) {
        String html = call.getString("html");
        String jobName = call.getString("jobName", "噪音記錄器_蒐證報告");
        if (html == null || html.isEmpty() || getActivity() == null) {
            call.reject("無報告內容可供列印");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                if (activePrintWebView != null) {
                    activePrintWebView.destroy();
                    activePrintWebView = null;
                }
                WebView webView = new WebView(getActivity());
                webView.getSettings().setJavaScriptEnabled(false);
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        if (printManager != null) {
                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                            PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .build();
                            printManager.print(jobName, adapter, attrs);
                        }
                    }
                });
                activePrintWebView = webView;
                webView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
                call.resolve();
            } catch (Exception ex) {
                call.reject("啟動列印預覽失敗: " + ex.getMessage(), ex);
            }
        });
    }

    @PluginMethod
    public void getBatteryStatus(PluginCall call) {
        Context context = getContext();
        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryIntent = context.registerReceiver(null, filter);

        int levelPct = 100;
        boolean isCharging = false;
        if (batteryIntent != null) {
            int level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) {
                levelPct = Math.round((level * 100f) / scale);
            }
            int status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;
        }

        boolean ignoringBatteryOpt = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                ignoringBatteryOpt = pm.isIgnoringBatteryOptimizations(context.getPackageName());
            }
        }

        JSObject ret = new JSObject();
        ret.put("level", levelPct);
        ret.put("isCharging", isCharging);
        ret.put("ignoringBatteryOptimizations", ignoringBatteryOpt);
        call.resolve(ret);
    }

    @PluginMethod
    @SuppressLint("BatteryLife")
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        Context context = getContext();
        boolean ignoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && getActivity() != null) {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            ignoring = pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
            if (!ignoring) {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + context.getPackageName()));
                    getActivity().startActivity(intent);
                } catch (Exception ex) {
                    try {
                        Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                        getActivity().startActivity(fallback);
                    } catch (Exception ignored) {
                        // Ignore if device vendor removes battery optimization screen
                    }
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("ignoringBatteryOptimizations", ignoring);
        call.resolve(ret);
    }
}
