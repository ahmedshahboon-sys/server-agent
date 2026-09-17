package ly.shahboun.voiceprobe;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.media.audiofx.AudioEffect;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import rikka.shizuku.Shizuku;

public class MainActivity extends android.app.Activity {

    private static final int SHIZUKU_REQUEST_CODE = 1001;
    private static final String MODIFY_DEFAULT_AUDIO_EFFECTS =
            "android.permission.MODIFY_DEFAULT_AUDIO_EFFECTS";

    private TextView headline;
    private TextView reportView;
    private Button requestShizukuButton;
    private Button scanButton;
    private IProbeService probeService;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String lastReport = "";
    private boolean bindingService = false;
    private Shizuku.UserServiceArgs serviceArgs;

    private final Shizuku.OnBinderReceivedListener binderReceivedListener = () -> {
        runOnUiThread(() -> {
            updateTopStatus();
            if (hasShizukuPermission()) bindProbeService();
        });
    };

    private final Shizuku.OnBinderDeadListener binderDeadListener = () -> {
        probeService = null;
        bindingService = false;
        runOnUiThread(this::updateTopStatus);
    };

    private final Shizuku.OnRequestPermissionResultListener permissionListener =
            (requestCode, grantResult) -> {
                if (requestCode != SHIZUKU_REQUEST_CODE) return;
                runOnUiThread(() -> {
                    updateTopStatus();
                    if (grantResult == PackageManager.PERMISSION_GRANTED) {
                        bindProbeService();
                    } else {
                        Toast.makeText(this, "تم رفض صلاحية Shizuku", Toast.LENGTH_LONG).show();
                    }
                });
            };

    private final ServiceConnection userServiceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            probeService = IProbeService.Stub.asInterface(service);
            bindingService = false;
            runOnUiThread(() -> {
                updateTopStatus();
                runFullProbe();
            });
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            probeService = null;
            bindingService = false;
            runOnUiThread(MainActivity.this::updateTopStatus);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        serviceArgs = new Shizuku.UserServiceArgs(
                new ComponentName(BuildConfig.APPLICATION_ID, ProbeUserService.class.getName()))
                .processNameSuffix("probe")
                .debuggable(true)
                .version(1)
                .daemon(false);

        Shizuku.addBinderReceivedListener(binderReceivedListener);
        Shizuku.addBinderDeadListener(binderDeadListener);
        Shizuku.addRequestPermissionResultListener(permissionListener);

        buildUi();
        updateTopStatus();

        if (isShizukuAlive() && hasShizukuPermission()) bindProbeService();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateTopStatus();
    }

    @Override
    protected void onDestroy() {
        Shizuku.removeBinderReceivedListener(binderReceivedListener);
        Shizuku.removeBinderDeadListener(binderDeadListener);
        Shizuku.removeRequestPermissionResultListener(permissionListener);
        worker.shutdownNow();
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(28));
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("VoiceProbe — فحص تغيير الصوت العالمي");
        title.setTextSize(24);
        title.setGravity(Gravity.START);
        root.addView(title, matchWrap());

        TextView subtitle = new TextView(this);
        subtitle.setText("يفحص جهازك بدون Root وبدون تعديل دائم لملفات النظام. الاختبار المؤقت لأي Audio Effect يتم إزالته فورًا.");
        subtitle.setTextSize(15);
        subtitle.setPadding(0, dp(8), 0, dp(18));
        root.addView(subtitle, matchWrap());

        headline = new TextView(this);
        headline.setTextSize(19);
        headline.setPadding(dp(14), dp(14), dp(14), dp(14));
        root.addView(headline, matchWrap());

        requestShizukuButton = button("طلب صلاحية Shizuku", v -> requestShizukuPermission());
        root.addView(requestShizukuButton, matchWrap());
        root.addView(button("فتح تطبيق Shizuku", v -> openShizuku()), matchWrap());
        root.addView(button("السماح بالظهور فوق التطبيقات", v -> openOverlaySettings()), matchWrap());

        scanButton = button("فحص الجهاز الآن", v -> {
            if (!isShizukuAlive()) {
                Toast.makeText(this, "شغّل Shizuku أولًا", Toast.LENGTH_LONG).show();
                openShizuku();
                return;
            }
            if (!hasShizukuPermission()) {
                requestShizukuPermission();
                return;
            }
            if (probeService == null) {
                bindProbeService();
                Toast.makeText(this, "جاري تجهيز خدمة الفحص…", Toast.LENGTH_SHORT).show();
                return;
            }
            runFullProbe();
        });
        root.addView(scanButton, matchWrap());
        root.addView(button("نسخ التقرير", v -> copyReport()), matchWrap());

        reportView = new TextView(this);
        reportView.setTextSize(14);
        reportView.setTextIsSelectable(true);
        reportView.setPadding(dp(4), dp(20), dp(4), dp(20));
        reportView.setText("اضغط «فحص الجهاز الآن» بعد تشغيل Shizuku ومنحه الصلاحية.");
        root.addView(reportView, matchWrap());

        setContentView(scroll);
    }

    private Button button(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(listener);
        return b;
    }

    private LinearLayout.LayoutParams matchWrap() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        return lp;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private boolean isShizukuAlive() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean hasShizukuPermission() {
        try {
            return isShizukuAlive()
                    && !Shizuku.isPreV11()
                    && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void requestShizukuPermission() {
        if (!isShizukuAlive()) {
            Toast.makeText(this, "Shizuku غير شغال. افتحه وشغّل الخدمة أولًا.", Toast.LENGTH_LONG).show();
            openShizuku();
            return;
        }
        try {
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                bindProbeService();
                return;
            }
            Shizuku.requestPermission(SHIZUKU_REQUEST_CODE);
        } catch (Throwable t) {
            Toast.makeText(this, "تعذر طلب الصلاحية: " + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void bindProbeService() {
        if (probeService != null || bindingService || !hasShizukuPermission()) return;
        try {
            bindingService = true;
            Shizuku.bindUserService(serviceArgs, userServiceConnection);
        } catch (Throwable t) {
            bindingService = false;
            reportView.setText("تعذر تشغيل خدمة الفحص بصلاحية Shell:\n" + t);
        }
    }

    private void updateTopStatus() {
        boolean alive = isShizukuAlive();
        boolean granted = hasShizukuPermission();
        boolean overlay = Settings.canDrawOverlays(this);

        String state;
        if (!alive) state = "⚪ يلزم تشغيل Shizuku";
        else if (!granted) state = "🟡 Shizuku شغال — يلزم السماح للتطبيق";
        else if (probeService == null) state = "🟡 الصلاحية موجودة — جاري تجهيز الفحص";
        else state = "🟢 جاهز للفحص";

        headline.setText(state + "\nOverlay: " + (overlay ? "مسموح" : "غير مسموح"));
        requestShizukuButton.setEnabled(alive && !granted);
    }

    private void runFullProbe() {
        if (probeService == null) return;
        scanButton.setEnabled(false);
        reportView.setText("جاري الفحص…");

        worker.execute(() -> {
            String report = performProbe();
            lastReport = report;
            runOnUiThread(() -> {
                reportView.setText(report);
                scanButton.setEnabled(true);
                updateTopStatus();
            });
        });
    }

    private String performProbe() {
        StringBuilder out = new StringBuilder();
        out.append("VOICEPROBE REPORT\n");
        out.append("=================\n");
        out.append("الجهاز: ").append(android.os.Build.MANUFACTURER).append(' ')
                .append(android.os.Build.MODEL).append("\n");
        out.append("Android: ").append(android.os.Build.VERSION.RELEASE)
                .append(" (API ").append(android.os.Build.VERSION.SDK_INT).append(")\n");
        out.append("Build: ").append(android.os.Build.DISPLAY).append("\n\n");

        try {
            out.append("Shizuku UID: ").append(Shizuku.getUid()).append("\n");
            out.append("Shizuku API: ").append(Shizuku.getVersion()).append("\n");
            out.append("SELinux: ").append(Shizuku.getSELinuxContext()).append("\n");
            int remotePermission = Shizuku.checkRemotePermission(MODIFY_DEFAULT_AUDIO_EFFECTS);
            boolean canModifyDefaultEffects = remotePermission == PackageManager.PERMISSION_GRANTED;
            out.append("MODIFY_DEFAULT_AUDIO_EFFECTS: ")
                    .append(canModifyDefaultEffects ? "GRANTED" : "DENIED").append("\n");
            out.append("Remote service UID: ").append(probeService.getRemoteUid()).append("\n\n");

            AudioEffect.Descriptor[] effects = AudioEffect.queryEffects();
            List<AudioEffect.Descriptor> all = new ArrayList<>();
            List<AudioEffect.Descriptor> voiceCandidates = new ArrayList<>();
            if (effects != null) {
                for (AudioEffect.Descriptor d : effects) {
                    all.add(d);
                    String haystack = ((d.name == null ? "" : d.name) + " "
                            + (d.implementor == null ? "" : d.implementor)).toLowerCase(Locale.ROOT);
                    if (haystack.contains("pitch") || haystack.contains("formant")
                            || haystack.contains("voice") || haystack.contains("vocal")
                            || haystack.contains("changer") || haystack.contains("karaoke")) {
                        voiceCandidates.add(d);
                    }
                }
            }

            out.append("Audio Effects الموجودة: ").append(all.size()).append("\n");
            out.append("مرشحات Voice/Pitch المحتملة: ").append(voiceCandidates.size()).append("\n\n");

            String mechanismSuccess = null;
            String mechanismFailure = null;
            if (canModifyDefaultEffects) {
                int attempts = 0;
                for (AudioEffect.Descriptor d : all) {
                    if (attempts++ >= 16) break;
                    String result = probeService.testDefaultEffect(
                            d.type.toString(), d.uuid.toString(), MediaRecorder.AudioSource.MIC);
                    if (result.startsWith("SUCCESS")) {
                        mechanismSuccess = describe(d);
                        break;
                    }
                    mechanismFailure = result;
                }
            }

            String voiceSuccess = null;
            String voiceFailure = null;
            if (canModifyDefaultEffects) {
                for (AudioEffect.Descriptor d : voiceCandidates) {
                    String result = probeService.testDefaultEffect(
                            d.type.toString(), d.uuid.toString(), MediaRecorder.AudioSource.MIC);
                    if (result.startsWith("SUCCESS")) {
                        voiceSuccess = describe(d);
                        break;
                    }
                    voiceFailure = result;
                }
            }

            out.append("اختبار إضافة Effect مؤقت للـMIC: ")
                    .append(mechanismSuccess != null ? "SUCCESS" : "FAILED").append("\n");
            if (mechanismSuccess != null) out.append("نجح مع: ").append(mechanismSuccess).append("\n");
            if (mechanismSuccess == null && mechanismFailure != null)
                out.append("آخر خطأ: ").append(mechanismFailure).append("\n");

            out.append("اختبار Voice/Pitch Effect موجود: ")
                    .append(voiceSuccess != null ? "SUCCESS" : "NOT FOUND / FAILED").append("\n");
            if (voiceSuccess != null) out.append("نجح مع: ").append(voiceSuccess).append("\n");
            if (voiceSuccess == null && voiceFailure != null)
                out.append("آخر خطأ Voice: ").append(voiceFailure).append("\n");

            out.append("\nالنتيجة النهائية\n---------------\n");
            if (!canModifyDefaultEffects) {
                out.append("🔴 RED — صلاحية ADB/Shell على هذا النظام لا تسمح بإدارة Default Audio Effects.\n");
            } else if (voiceSuccess != null) {
                out.append("🟢 GREEN — المسار يعمل بدون Root ويوجد Effect صوتي محتمل يقبل الربط مع MIC. نقدر ننتقل لبناء نموذج Voice Changer فعلي.\n");
            } else if (mechanismSuccess != null) {
                out.append("🟡 YELLOW — Shizuku/Shell قادر على تركيب Effect عالمي مؤقت على MIC، لكن لم نجد Voice/Pitch Effect مناسبًا جاهزًا في Samsung. آلية التحكم ممكنة لكن نحتاج محرك صوت مناسب أو طريق نظام إضافي.\n");
            } else {
                out.append("🟠 ORANGE — الصلاحية موجودة نظريًا لكن طبقة الصوت في هذا الجهاز رفضت Effects التي جُرّبت على MIC. نحتاج فحص Audio Policy الخاص بسامسونج.\n");
            }

            out.append("\nقائمة المؤثرات\n---------------\n");
            int index = 1;
            for (AudioEffect.Descriptor d : all) {
                out.append(index++).append(") ").append(describe(d)).append("\n");
                out.append("   type=").append(d.type).append("\n");
                out.append("   uuid=").append(d.uuid).append("\n");
            }

        } catch (Throwable t) {
            out.append("\n🔴 فشل الفحص: ").append(t.getClass().getSimpleName())
                    .append(": ").append(t.getMessage()).append("\n");
        }

        return out.toString();
    }

    private String describe(AudioEffect.Descriptor d) {
        return (d.name == null ? "Unnamed" : d.name)
                + " — " + (d.implementor == null ? "Unknown" : d.implementor);
    }

    private void openShizuku() {
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage("moe.shizuku.privileged.api");
            if (launch != null) {
                startActivity(launch);
            } else {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://shizuku.rikka.app/download/")));
            }
        } catch (Throwable t) {
            Toast.makeText(this, "تعذر فتح Shizuku", Toast.LENGTH_LONG).show();
        }
    }

    private void openOverlaySettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Throwable t) {
            Toast.makeText(this, "تعذر فتح إعداد الظهور فوق التطبيقات", Toast.LENGTH_LONG).show();
        }
    }

    private void copyReport() {
        if (lastReport == null || lastReport.isEmpty()) {
            Toast.makeText(this, "شغّل الفحص أولًا", Toast.LENGTH_SHORT).show();
            return;
        }
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("VoiceProbe report", lastReport));
        Toast.makeText(this, "تم نسخ التقرير", Toast.LENGTH_SHORT).show();
    }
}
