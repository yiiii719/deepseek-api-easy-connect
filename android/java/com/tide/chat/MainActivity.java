package com.tide.chat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 潮汐 · 自包含客户端
 * 1) 内部起一个 127.0.0.1 的后端（LocalServer），前端就是随包的 web/；
 * 2) WebView 加载它，所以“装上 → 填 Key → 能用”，不需要额外装 Node 或连电脑；
 * 3) 也允许指到别处（长按菜单 → 服务器地址），方便接电脑上的同一套服务。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "tide";
    private static final String KEY_URL = "server_url";
    private static final int REQ_FILE = 1001;

    private WebView web;
    private SharedPreferences prefs;
    private LocalServer server;
    private ValueCallback<Uri[]> pendingFiles;
    private long lastBackAt = 0L;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        server = new LocalServer(this);
        server.start();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFBF8F2);

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        WebView.setWebContentsDebuggingEnabled(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleUrl(req.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    String d = err == null || err.getDescription() == null ? "" : err.getDescription().toString();
                    showOffline(d);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFiles = null;
                    toast("打不开文件选择器");
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                request.grant(request.getResources());
            }
        });

        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                showMenu();
                return true;
            }
        });

        web.loadUrl(currentUrl());
    }

    /** 默认用 App 内置后端；用户改过就用改的 */
    private String currentUrl() {
        String custom = prefs.getString(KEY_URL, "");
        if (custom != null && !custom.isEmpty() && !custom.startsWith("builtin")) return custom;
        return server.baseUrl();
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (!scheme.startsWith("http")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }
        String host = uri.getHost() == null ? "" : uri.getHost();
        boolean local = host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1")
                || host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.");
        if (local) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            return false;
        }
        return true;
    }

    private void showMenu() {
        final String[] items = {"服务器地址", "用内置后端", "重新加载", "用系统浏览器打开", "关于"};
        new AlertDialog.Builder(this)
                .setTitle("潮汐")
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) showServerDialog();
                        else if (which == 1) {
                            prefs.edit().remove(KEY_URL).apply();
                            web.loadUrl(server.baseUrl());
                            toast("已切回内置后端");
                        } else if (which == 2) web.reload();
                        else if (which == 3) {
                            try {
                                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl())));
                            } catch (Exception e) {
                                toast("没有可用的浏览器");
                            }
                        } else {
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("关于")
                                    .setMessage("潮汐 1.1.0\n\n"
                                            + "自包含 AI 客户端：界面、后端、存储都在这个 App 里，数据不出设备。\n\n"
                                            + "内置后端：" + server.baseUrl() + "\n"
                                            + "当前页面：" + currentUrl() + "\n\n"
                                            + "长按屏幕可再次打开这个菜单。")
                                    .setPositiveButton("知道了", null)
                                    .show();
                        }
                    }
                })
                .show();
    }

    private void showServerDialog() {
        final EditText input = new EditText(this);
        input.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("留空 = 用 App 内置后端");
        String cur = prefs.getString(KEY_URL, "");
        input.setText(cur);
        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("默认用 App 自带的后端（127.0.0.1）。\n如果想接电脑上跑的那套，填电脑 IP，例如 192.168.1.13:8899。")
                .setView(input)
                .setPositiveButton("保存并加载", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        String v = input.getText().toString().trim();
                        if (v.isEmpty()) {
                            prefs.edit().remove(KEY_URL).apply();
                            web.loadUrl(server.baseUrl());
                            return;
                        }
                        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
                        if (!v.endsWith("/")) v = v + "/";
                        prefs.edit().putString(KEY_URL, v).apply();
                        web.loadUrl(v);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void showOffline(String detail) {
        String url = currentUrl();
        String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;background:#fbf8f2;color:#1b1d1c;font:16px/1.7 -apple-system,sans-serif;padding:32px 22px'>"
                + "<div style='display:inline-block;padding:4px 9px;border-radius:8px;background:#e4f4f1;color:#0f9f8f;font-size:12px;letter-spacing:.14em'>TIDE</div>"
                + "<h2 style='margin:14px 0 6px;font-size:22px'>页面没加载出来</h2>"
                + "<p style='color:#58605c;margin:0 0 18px'>地址：<code style='background:#f4f0e7;padding:2px 6px;border-radius:5px'>" + url + "</code></p>"
                + "<p style='color:#58605c;margin:0 0 18px;font-size:14px'>" + (detail == null ? "" : detail) + "</p>"
                + "<ol style='color:#58605c;font-size:14px;padding-left:20px'>"
                + "<li>App 自带后端应该一直是好的，先点下面重试</li>"
                + "<li><b>长按屏幕</b> → 「用内置后端」 可以切回来</li>"
                + "<li>如果你指到了电脑上的服务端，确认那台机器在同一局域网</li>"
                + "</ol></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) super.onBackPressed();
        else {
            lastBackAt = now;
            toast("再按一次退出");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFiles != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                pendingFiles.onReceiveValue(result);
                pendingFiles = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        try {
            if (web != null) web.destroy();
        } catch (Exception ignored) {
        }
        web = null;
        if (server != null) server.stop();
        super.onDestroy();
    }
}
