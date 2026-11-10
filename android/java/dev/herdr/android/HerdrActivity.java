package dev.herdr.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import dev.gpui.mobile.GpuiInputActivity;

public final class HerdrActivity extends GpuiInputActivity implements SurfaceHolder.Callback {
    private android.view.View keyBar;
    private LinearLayout content;
    private Button ctrlKey;
    private boolean ctrl;
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            android.system.Os.setenv("HOME", getFilesDir().getAbsolutePath(), true);
            android.system.Os.setenv("TMPDIR", getCacheDir().getAbsolutePath(), true);
        } catch (android.system.ErrnoException error) {
            throw new IllegalStateException("Could not prepare Herdr storage", error);
        }
        nativeStart(getFilesDir().getAbsolutePath());
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        SurfaceView surface = new SurfaceView(this);
        surface.setFocusable(true);
        surface.setFocusableInTouchMode(true);
        surface.getHolder().addCallback(this);
        surface.setOnTouchListener((view, event) -> {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_MOVE || action == MotionEvent.ACTION_CANCEL) {
                for (int i = 0; i < event.getPointerCount(); i++)
                    nativeTouch(action, event.getPointerId(i), event.getX(i), event.getY(i));
            } else {
                int i = event.getActionIndex();
                if (action == MotionEvent.ACTION_POINTER_DOWN) action = MotionEvent.ACTION_DOWN;
                if (action == MotionEvent.ACTION_POINTER_UP) action = MotionEvent.ACTION_UP;
                nativeTouch(action, event.getPointerId(i), event.getX(i), event.getY(i));
            }
            return true;
        });
        surface.setOnKeyListener((view, code, event) -> {
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) return false;
            nativeKey(code, event.getAction(), event.getMetaState());
            return true;
        });
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.addView(surface, new LinearLayout.LayoutParams(-1, 0, 1f));
        content.addView(keyBar(), new LinearLayout.LayoutParams(-1, -2));
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                        | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                // The key row is for typing: it shows while the keyboard does.
                keyBar.setVisibility(keyboard.bottom > bars.bottom ? android.view.View.VISIBLE : android.view.View.GONE);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(content);
        // Android 13+ sends Back here, not to onBackPressed or key events.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> nativeRun("app.back"));
        }
        content.requestApplyInsets();
        surface.requestFocus();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        return dispatchNativeKey(event) || super.dispatchKeyEvent(event);
    }

    // Back closes Herdr's own dialogs and screens first (app.back); Herdr
    // sends the app to the background when nothing is left.
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { nativeRun("app.back"); }

    @Override protected boolean dispatchNativeKey(KeyEvent event) {
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) nativeRun("app.back");
            return true;
        }
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        // The key row's Ctrl holds for the next letter typed.
        if (ctrl && event.getAction() == KeyEvent.ACTION_DOWN
                && code >= KeyEvent.KEYCODE_A && code <= KeyEvent.KEYCODE_Z) {
            int meta = event.getMetaState() | KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
            nativeKey(code, KeyEvent.ACTION_DOWN, meta);
            nativeKey(code, KeyEvent.ACTION_UP, meta);
            setCtrl(false);
            return true;
        }
        // Keep shortcuts and terminal keys out of Android's text editor.
        boolean terminalKey = event.isCtrlPressed() || event.isAltPressed() || event.isMetaPressed()
                || code == KeyEvent.KEYCODE_TAB || code == KeyEvent.KEYCODE_ESCAPE
                || (code >= KeyEvent.KEYCODE_DPAD_UP && code <= KeyEvent.KEYCODE_DPAD_RIGHT)
                || code == KeyEvent.KEYCODE_PAGE_UP || code == KeyEvent.KEYCODE_PAGE_DOWN
                || code == KeyEvent.KEYCODE_MOVE_HOME || code == KeyEvent.KEYCODE_MOVE_END
                || code == KeyEvent.KEYCODE_FORWARD_DEL || code == KeyEvent.KEYCODE_INSERT
                || (code >= KeyEvent.KEYCODE_F1 && code <= KeyEvent.KEYCODE_F12);
        if (terminalKey && event.getAction() != KeyEvent.ACTION_MULTIPLE) {
            nativeKey(code, event.getAction(), event.getMetaState());
            return true;
        }
        return false;
    }

    @Override public void surfaceCreated(SurfaceHolder holder) { surfaceChanged(holder, 0, 0, 0); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        nativeSurface(holder.getSurface(), getResources().getDisplayMetrics().density);
    }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { nativeSurfaceDestroyed(); }
    @Override protected void onResume() { super.onResume(); nativeResume(); }
    @Override protected void onPause() { nativePause(); super.onPause(); }

    public String gpuiClipboardRead() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        return text == null ? "" : text.toString();
    }

    public void gpuiClipboardWrite(String text) {
        runOnUiThread(() -> ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
                .setPrimaryClip(ClipData.newPlainText("Herdr", text)));
    }

    // The keys a phone keyboard lacks, as the web app's key row has them.
    private android.view.View keyBar() {
        LinearLayout keyRow = new LinearLayout(this);
        keyRow.setOrientation(LinearLayout.HORIZONTAL);
        keyRow.setBackgroundColor(Color.parseColor("#1b1f24"));
        int pad = dp(4);
        keyRow.setPadding(pad, pad, pad, pad);
        Object[][] keys = {
            {"Esc", KeyEvent.KEYCODE_ESCAPE, 0}, {"Tab", KeyEvent.KEYCODE_TAB, 0}, {"Ctrl", -1, 0},
            {"^C", KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON},
            {"\u2190", KeyEvent.KEYCODE_DPAD_LEFT, 0}, {"\u2193", KeyEvent.KEYCODE_DPAD_DOWN, 0},
            {"\u2191", KeyEvent.KEYCODE_DPAD_UP, 0}, {"\u2192", KeyEvent.KEYCODE_DPAD_RIGHT, 0},
            {"Copy", -3, 0}, {"Paste", -2, 0},
        };
        for (Object[] key : keys) {
            Button button = new Button(this, null, android.R.attr.borderlessButtonStyle);
            button.setText((String) key[0]);
            button.setAllCaps(false);
            button.setTextColor(Color.parseColor("#e6e6e6"));
            button.setTextSize(15);
            button.setMinWidth(dp(48));
            button.setMinimumWidth(dp(48));
            button.setMinHeight(dp(42));
            button.setMinimumHeight(dp(42));
            button.setPadding(dp(10), 0, dp(10), 0);
            button.setBackground(keyBackground(false));
            button.setFocusable(false);
            int code = (Integer) key[1], meta = (Integer) key[2];
            if (code == -1) ctrlKey = button;
            button.setOnClickListener(view -> {
                view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
                if (code == -1) { setCtrl(!ctrl); return; }
                if (code == -2) { nativeRun("terminal.paste"); return; }
                if (code == -3) { nativeRun("terminal.copy"); return; }
                int held = meta | (ctrl ? KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON : 0);
                nativeKey(code, KeyEvent.ACTION_DOWN, held);
                nativeKey(code, KeyEvent.ACTION_UP, held);
                setCtrl(false);
            });
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, dp(42));
            params.setMargins(dp(2), 0, dp(2), 0);
            keyRow.addView(button, params);
        }
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setBackgroundColor(Color.parseColor("#1b1f24"));
        scroll.addView(keyRow);
        scroll.setVisibility(android.view.View.GONE);
        keyBar = scroll;
        return scroll;
    }

    private void setCtrl(boolean on) {
        ctrl = on;
        if (ctrlKey != null) ctrlKey.setBackground(keyBackground(on));
    }

    private GradientDrawable keyBackground(boolean on) {
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(8));
        shape.setColor(Color.parseColor(on ? "#3d6fb6" : "#2a2f37"));
        return shape;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    // The theme's colors behind the status and navigation bars, with icons that
    // read on them. The content view's padding is the bars' space; it shows its
    // background there (Android 15 ignores the bars' own colors).
    public void herdrSystemBars(int top, int bottom, boolean lightTop, boolean lightBottom) {
        runOnUiThread(() -> {
            content.setBackground(new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {
                new android.graphics.drawable.ColorDrawable(bottom), barTop(top) }));
            getWindow().setStatusBarColor(top);
            getWindow().setNavigationBarColor(bottom);
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                int status = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                int nav = android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                getWindow().getInsetsController().setSystemBarsAppearance(
                        (lightTop ? status : 0) | (lightBottom ? nav : 0), status | nav);
            }
        });
    }

    // The top half of the content's background: the status bar's color.
    private android.graphics.drawable.Drawable barTop(int color) {
        return new android.graphics.drawable.Drawable() {
            final android.graphics.Paint paint = new android.graphics.Paint();
            @Override public void draw(android.graphics.Canvas canvas) {
                paint.setColor(color);
                canvas.drawRect(0, 0, getBounds().width(), getBounds().height() / 2f, paint);
            }
            @Override public void setAlpha(int alpha) {}
            @Override public void setColorFilter(android.graphics.ColorFilter filter) {}
            @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
        };
    }

    // The view's own feedback, so the person's "touch vibration" setting applies.
    public void herdrHaptic() {
        runOnUiThread(() -> getWindow().getDecorView().performHapticFeedback(
                android.view.HapticFeedbackConstants.VIRTUAL_KEY));
    }

    public void herdrPlaySound(String path) {
        android.media.MediaPlayer player = new android.media.MediaPlayer();
        try {
            player.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_EVENT).build());
            player.setDataSource(path);
            player.setOnCompletionListener(android.media.MediaPlayer::release);
            player.prepare();
            player.start();
        } catch (java.io.IOException error) {
            player.release();
            throw new IllegalStateException("Cannot play " + path, error);
        }
    }

    // Shown while Herdr is in the background too; opening it brings Herdr back.
    public void herdrNotify(String title, String body) {
        android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
        manager.createNotificationChannel(new android.app.NotificationChannel(
                "agents", "Agents", android.app.NotificationManager.IMPORTANCE_DEFAULT));
        android.content.Intent open = new android.content.Intent(this, HerdrActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
        android.app.PendingIntent tap = android.app.PendingIntent.getActivity(this, 0, open,
                android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        android.app.Notification notification = new android.app.Notification.Builder(this, "agents")
                .setSmallIcon(R.drawable.herdr).setContentTitle(title).setContentText(body)
                .setContentIntent(tap).setAutoCancel(true).build();
        manager.notify(title.hashCode(), notification);
    }

    private native void nativeStart(String folder);
    private native void nativeSurface(Surface surface, float density);
    private native void nativeSurfaceDestroyed();
    private native void nativeTouch(int action, int id, float x, float y);
    private native void nativeKey(int code, int action, int modifiers);
    private native void nativeResume();
    private native void nativePause();
    private native void nativeRun(String command);
}
