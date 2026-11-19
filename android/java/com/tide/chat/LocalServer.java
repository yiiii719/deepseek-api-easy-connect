package com.tide.chat;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 内置后端：一个跑在 127.0.0.1 上的极简 HTTP 服务。
 * 前端仍然是那套 web/（同一份代码），所以界面/功能零差异；
 * 区别是这里直接用 HttpURLConnection 打上游，不再需要 Node。
 */
public class LocalServer {

    private static final String VERSION = "1.1.0";
    private final Context ctx;
    private final Store store;
    private final AssetManager assets;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket server;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private int port = 0;

    public LocalServer(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.store = new Store(this.ctx);
        this.assets = this.ctx.getAssets();
    }

    public int getPort() {
        return port;
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + port + "/";
    }

    /** 优先 8899（跟 Node 版一致），被占用就顺延 */
    public void start() {
        int[] candidates = {8899, 8900, 8901, 8902};
        for (int p : candidates) {
            try {
                server = new ServerSocket(p, 64, InetAddress.getByName("127.0.0.1"));
                port = p;
                break;
            } catch (Exception ignored) {
            }
        }
        if (server == null) {
            Log.e("TIDE", "no free port");
            return;
        }
        running.set(true);
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running.get()) {
                    try {
                        final Socket s = server.accept();
                        pool.execute(new Runnable() {
                            @Override
                            public void run() {
                                handle(s);
                            }
                        });
                    } catch (Exception e) {
                        if (running.get()) Log.e("TIDE", "accept", e);
                    }
                }
            }
        }, "tide-http");
        t.setDaemon(true);
        t.start();
        Log.i("TIDE", "local server on " + baseUrl());
    }

    public void stop() {
        running.set(false);
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
        }
    }

    /* ───────────────────────── 请求处理 ───────────────────────── */

    private void handle(Socket sock) {
        try {
            sock.setTcpNoDelay(true);
            InputStream in = sock.getInputStream();
            OutputStream out = new BufferedOutputStream(sock.getOutputStream(), 8192);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                sock.close();
                return;
            }
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";
            int qm = path.indexOf('?');
            String query = qm >= 0 ? path.substring(qm + 1) : "";
            if (qm >= 0) path = path.substring(0, qm);

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT), line.substring(c + 1).trim());
            }
            int len = 0;
            try {
                len = Integer.parseInt(headers.getOrDefault("content-length", "0"));
            } catch (Exception ignored) {
            }
            byte[] body = new byte[len];
            int read = 0;
            while (read < len) {
                int n = in.read(body, read, len - read);
                if (n < 0) break;
                read += n;
            }
            String bodyStr = read > 0 ? new String(body, 0, read, StandardCharsets.UTF_8) : "";

            route(method, path, query, bodyStr, out);
            out.flush();
            sock.close();
        } catch (Exception e) {
            Log.e("TIDE", "handle", e);
            try {
                sock.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void route(String method, String path, String query, String body, OutputStream out) throws Exception {
        if (path.startsWith("/api/")) {
            api(method, path, query, body, out);
            return;
        }
        serveAsset(path, out);
    }

    /* ───────────────────────── 静态资源 ───────────────────────── */

    private void serveAsset(String path, OutputStream out) throws Exception {
        String rel = "/".equals(path) ? "index.html" : path.substring(1);
        if (rel.contains("..")) {
            writeText(out, 403, "forbidden", "text/plain");
            return;
        }
        String asset = "web/" + rel;
        try {
            InputStream is = assets.open(asset);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            is.close();
            byte[] data = bos.toByteArray();
            writeHeaders(out, 200, mime(rel), data.length, false);
            out.write(data);
        } catch (Exception e) {
            // SPA 兜底
            try {
                InputStream is = assets.open("web/index.html");
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
                byte[] data = bos.toByteArray();
                writeHeaders(out, 200, "text/html; charset=utf-8", data.length, false);
                out.write(data);
            } catch (Exception e2) {
                writeText(out, 404, "not found", "text/plain");
            }
        }
    }

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        if (p.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /* ───────────────────────── API ───────────────────────── */

    private void api(String method, String path, String query, String body, OutputStream out) throws Exception {
        if (path.equals("/api/health")) {
            writeJson(out, 200, new JSONObject().put("ok", true).put("version", VERSION)
                    .put("store", "json").put("node", "native").put("uptime", 0));
            return;
        }

        if (path.equals("/api/bootstrap")) {
            JSONObject s = settings();
            JSONObject resp = new JSONObject();
            JSONObject pub = new JSONObject(s.toString());
            pub.remove("providersList");
            resp.put("settings", pub);
            // 服务商对外只给 hasKey，不回传 key 本身
            JSONArray raw = s.optJSONArray("providersList");
            JSONArray safe = new JSONArray();
            if (raw != null) {
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject p = raw.optJSONObject(i);
                    if (p == null) continue;
                    JSONObject copy = new JSONObject(p.toString());
                    String key = copy.optString("apiKey", "");
                    copy.remove("apiKey");
                    copy.put("hasKey", !key.isEmpty() || "demo".equals(copy.optString("id")));
                    safe.put(copy);
                }
            }
            resp.put("providers", safe);
            resp.put("conversations", store.listConversations());
            resp.put("version", VERSION);
            writeJson(out, 200, resp);
            return;
        }

        if (path.equals("/api/settings") && "POST".equals(method)) {
            JSONObject patch = body.isEmpty() ? new JSONObject() : new JSONObject(body);
            store.patchSettings(patch);
            JSONObject s = settings();
            JSONObject pub = new JSONObject(s.toString());
            pub.remove("providersList");
            writeJson(out, 200, new JSONObject().put("ok", true).put("settings", pub));
            return;
        }

        if (path.equals("/api/conversations") && "GET".equals(method)) {
            writeJson(out, 200, store.listConversations());
            return;
        }
        if (path.equals("/api/conversations") && "POST".equals(method)) {
            JSONObject b = body.isEmpty() ? new JSONObject() : new JSONObject(body);
            writeJson(out, 200, store.createConversation(b.optString("title", "新对话"), "", ""));
            return;
        }

        if (path.startsWith("/api/conversations/")) {
            String[] seg = path.split("/");
            String id = seg.length > 3 ? seg[3] : "";
            if (seg.length > 4 && "messages".equals(seg[4]) && seg.length > 5 && "DELETE".equals(method)) {
                store.deleteMessage(id, seg[5]);
                writeJson(out, 200, new JSONObject().put("ok", true));
                return;
            }
            if ("GET".equals(method)) {
                JSONObject conv = store.getConversation(id);
                if (conv == null) {
                    writeJson(out, 404, new JSONObject().put("error", "not found"));
                    return;
                }
                conv.put("messages", store.listMessages(id));
                writeJson(out, 200, conv);
                return;
            }
            if ("PATCH".equals(method)) {
                JSONObject b = body.isEmpty() ? new JSONObject() : new JSONObject(body);
                JSONObject c = store.updateConversation(id, b);
                writeJson(out, 200, c == null ? new JSONObject().put("error", "not found") : c);
                return;
            }
            if ("DELETE".equals(method)) {
                store.deleteConversation(id);
                writeJson(out, 200, new JSONObject().put("ok", true));
                return;
            }
        }

        if (path.equals("/api/attachments") && "POST".equals(method)) {
            JSONObject b = new JSONObject(body);
            String name = b.optString("name", "文件");
            String b64 = b.optString("data", "");
            byte[] raw = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            String text = Extract.text(name, raw);
            if (text == null || text.isEmpty()) {
                writeJson(out, 400, new JSONObject().put("error", "这个格式在 App 内解析不了，换成 txt/md/csv/docx"));
                return;
            }
            JSONObject saved = store.saveAttachment(name, text, raw.length);
            if (saved == null) {
                writeJson(out, 500, new JSONObject().put("error", "保存失败"));
                return;
            }
            saved.put("kind", "text");
            saved.put("preview", text.length() > 300 ? text.substring(0, 300) : text);
            writeJson(out, 200, saved);
            return;
        }

        if (path.equals("/api/search") && "POST".equals(method)) {
            JSONObject b = new JSONObject(body);
            JSONArray r = Upstream.search(b.optString("q", ""), b.optInt("limit", 5));
            writeJson(out, 200, new JSONObject().put("query", b.optString("q")).put("results", r).put("provider", "bing"));
            return;
        }

        if (path.equals("/api/models")) {
            JSONObject s = settings();
            JSONObject pv = resolveProvider(s, param(query, "provider"));
            JSONArray models = null;
            if (!"demo".equals(pv.optString("id")) && !pv.optString("apiKey").isEmpty()) {
                models = Upstream.listModels(pv);
            }
            if (models == null) models = pv.optJSONArray("models");
            writeJson(out, 200, new JSONObject().put("models", models == null ? new JSONArray() : models));
            return;
        }

        if (path.equals("/api/bench")) {
            JSONObject s = settings();
            JSONObject pv = resolveProvider(s, param(query, "provider"));
            String model = param(query, "model");
            if (model == null || model.isEmpty()) model = pickModel(s, pv, "", false);
            if ("demo".equals(pv.optString("id"))) {
                writeJson(out, 200, new JSONObject().put("ttft", 1).put("ms", 1).put("mode", "demo"));
                return;
            }
            if (pv.optString("apiKey").isEmpty()) {
                writeJson(out, 200, new JSONObject().put("error", "还没配置 API Key，先在设置里填上").put("provider", pv.optString("id")));
                return;
            }
            long ttft = Upstream.bench(pv, model);
            writeJson(out, 200, new JSONObject().put("ttft", ttft).put("ms", ttft).put("model", model).put("provider", pv.optString("id")));
            return;
        }

        if (path.equals("/api/chat") && "POST".equals(method)) {
            chat(body, out);
            return;
        }

        writeJson(out, 404, new JSONObject().put("error", "not found"));
    }

    /* ───────────────────────── 设置 / 服务商 ───────────────────────── */

    private JSONObject settings() {
        JSONObject def = new JSONObject();
        try {
            def.put("providerId", "deepseek");
            def.put("model", "");
            def.put("thinking", false);
            def.put("search", false);
            def.put("temperature", 1.0);
            def.put("maxTokens", 4096);
            def.put("topP", 1.0);
            def.put("contextChars", 24000);
            def.put("system", "");
            def.put("theme", "auto");
            def.put("fontSize", 16);
            def.put("streamRender", true);
            def.put("sendOnEnter", true);
            def.put("searchProvider", "bing");
            def.put("showStats", true);
        } catch (Exception ignored) {
        }
        JSONObject stored = store.getSettings();
        JSONObject merged = new JSONObject();
        try {
            java.util.Iterator<String> it = def.keys();
            while (it.hasNext()) {
                String k = it.next();
                merged.put(k, def.get(k));
            }
            java.util.Iterator<String> it2 = stored.keys();
            while (it2.hasNext()) {
                String k = it2.next();
                if ("providers".equals(k)) continue;
                merged.put(k, stored.get(k));
            }
        } catch (Exception ignored) {
        }
        // 服务商 = 预设 + 用户覆盖
        JSONArray presets = presets();
        JSONArray overrides = stored.optJSONArray("providers");
        JSONArray list = new JSONArray();
        for (int i = 0; i < presets.length(); i++) {
            JSONObject base = presets.optJSONObject(i);
            String id = base.optString("id");
            if (overrides != null) {
                for (int j = 0; j < overrides.length(); j++) {
                    JSONObject ov = overrides.optJSONObject(j);
                    if (ov != null && id.equals(ov.optString("id"))) {
                        java.util.Iterator<String> kk = ov.keys();
                        while (kk.hasNext()) {
                            String key = kk.next();
                            try {
                                base.put(key, ov.get(key));
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
            }
            list.put(base);
        }
        try {
            merged.put("providersList", list);
        } catch (Exception ignored) {
        }
        return merged;
    }

    private JSONArray presets() {
        JSONArray arr = new JSONArray();
        try {
            arr.put(new JSONObject()
                    .put("id", "deepseek")
                    .put("name", "DeepSeek 官方 API（推荐）")
                    .put("dialect", "openai")
                    .put("baseUrl", "https://api.deepseek.com/v1")
                    .put("apiKey", "")
                    .put("models", new JSONArray().put("deepseek-flash").put("deepseek-v4-pro"))
                    .put("defaultModel", "deepseek-flash")
                    .put("thinkingModel", "deepseek-v4-pro")
                    .put("effortSupported", true));
            arr.put(new JSONObject()
                    .put("id", "custom")
                    .put("name", "自定义（任意 OpenAI 兼容）")
                    .put("dialect", "openai")
                    .put("baseUrl", "")
                    .put("apiKey", "")
                    .put("models", new JSONArray())
                    .put("defaultModel", "")
                    .put("thinkingModel", ""));
            arr.put(new JSONObject()
                    .put("id", "demo")
                    .put("name", "演示模式（无需 Key）")
                    .put("dialect", "demo")
                    .put("baseUrl", "")
                    .put("apiKey", "")
                    .put("models", new JSONArray().put("demo"))
                    .put("defaultModel", "demo")
                    .put("thinkingModel", "demo"));
        } catch (Exception ignored) {
        }
        return arr;
    }

    private JSONObject resolveProvider(JSONObject s, String id) {
        JSONArray list = s.optJSONArray("providersList");
        String want = id == null || id.isEmpty() ? s.optString("providerId") : id;
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject p = list.optJSONObject(i);
                if (p != null && want.equals(p.optString("id"))) return p;
            }
            if (list.length() > 0) return list.optJSONObject(0);
        }
        return new JSONObject();
    }

    private String pickModel(JSONObject s, JSONObject pv, String bodyModel, boolean thinking) {
        String m = bodyModel;
        if (m == null || m.isEmpty()) m = s.optString("model");
        if (m.isEmpty()) m = pv.optString("defaultModel");
        if (m.isEmpty()) {
            JSONArray ms = pv.optJSONArray("models");
            m = ms != null && ms.length() > 0 ? ms.optString(0) : "deepseek-flash";
        }
        if (thinking && m.equals(pv.optString("defaultModel"))) {
            String tm = pv.optString("thinkingModel");
            if (!tm.isEmpty()) m = tm;
        }
        return m;
    }

    /* ───────────────────────── 对话（SSE） ───────────────────────── */

    private void chat(String body, OutputStream out) throws Exception {
        JSONObject s = settings();
        JSONObject b = new JSONObject(body);
        JSONObject pv = resolveProvider(s, b.optString("providerId", ""));
        boolean thinking = b.has("thinking") ? b.optBoolean("thinking") : s.optBoolean("thinking");
        String model = pickModel(s, pv, b.optString("model", ""), thinking);
        int maxTokens = b.has("maxTokens") ? b.optInt("maxTokens", 4096) : s.optInt("maxTokens", 4096);
        if (thinking) maxTokens = Math.max(maxTokens, 8192);
        double temp = b.has("temperature") ? b.optDouble("temperature", 1) : s.optDouble("temperature", 1);
        String system = joinNonEmpty(s.optString("system", ""), b.optString("system", ""));

        String userText = b.optString("text", "").trim();
        boolean regenerate = b.optBoolean("regenerate", false);

        JSONObject conv = null;
        if (!b.optString("convId", "").isEmpty()) conv = store.getConversation(b.optString("convId"));
        if (conv == null) conv = store.createConversation(titleFrom(userText), model, pv.optString("id"));
        final String convId = conv.optString("id");
        final String convTitle = conv.optString("title");

        if (regenerate) {
            JSONArray msgs = store.listMessages(convId);
            for (int i = msgs.length() - 1; i >= 0; i--) {
                JSONObject m = msgs.optJSONObject(i);
                if (m != null && "assistant".equals(m.optString("role"))) {
                    store.deleteMessage(convId, m.optString("id"));
                    break;
                }
            }
        } else {
            String truncateFrom = b.optString("truncateFrom", "");
            if (!truncateFrom.isEmpty()) store.truncateFrom(convId, truncateFrom);
            JSONObject meta = new JSONObject();
            meta.put("attachments", b.optJSONArray("attachments") == null ? new JSONArray() : b.optJSONArray("attachments"));
            meta.put("provider", pv.optString("id"));
            meta.put("model", model);
            store.addMessage(convId, "user", userText, "", meta);
        }

        // 上下文拼接
        StringBuilder ctxBlock = new StringBuilder();
        JSONArray attIds = b.optJSONArray("attachments");
        if (attIds != null && attIds.length() > 0) {
            StringBuilder files = new StringBuilder();
            for (int i = 0; i < attIds.length(); i++) {
                JSONObject a = store.getAttachment(attIds.optString(i));
                if (a != null) {
                    files.append("<file name=\"").append(a.optString("name")).append("\">\n")
                            .append(a.optString("text")).append("\n</file>\n\n");
                }
            }
            if (files.length() > 0) ctxBlock.append("以下是用户上传的文件内容，请以此为事实依据回答：\n\n").append(files);
        }

        // SSE 头
        writeHeaders(out, 200, "text/event-stream; charset=utf-8", -1, true);
        out.flush();

        String msgId = java.util.UUID.randomUUID().toString();
        long t0 = System.currentTimeMillis();
        sse(out, "meta", new JSONObject().put("convId", convId).put("messageId", msgId)
                .put("model", model).put("provider", pv.optString("name")).put("title", convTitle));

        boolean wantSearch = b.has("search") ? b.optBoolean("search") : s.optBoolean("search");
        JSONArray citations = new JSONArray();
        if (wantSearch) {
            String q = userText;
            sse(out, "search_start", new JSONObject().put("query", q));
            JSONArray results = Upstream.search(q, 5);
            StringBuilder sb = new StringBuilder();
            if (results.length() > 0) {
                sb.append("【联网搜索结果 · 抓取时间 ").append(new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(new java.util.Date())).append("】\n");
                for (int i = 0; i < results.length(); i++) {
                    JSONObject r = results.optJSONObject(i);
                    sb.append("[").append(i + 1).append("] ").append(r.optString("title")).append("\n")
                            .append("URL: ").append(r.optString("url")).append("\n")
                            .append(r.optString("snippet")).append("\n\n");
                    citations.put(new JSONObject().put("index", i + 1)
                            .put("title", r.optString("title")).put("url", r.optString("url")));
                }
                sb.append("【硬性要求】以上是刚刚实时抓到的资料，请据此回答，不要声称无法联网；引用处标 [编号]。");
                ctxBlock.append(sb);
            }
            sse(out, "search", new JSONObject().put("query", q).put("results", results).put("citations", citations));
        }

        JSONArray messages = buildMessages(convId, ctxBlock.toString(), s.optInt("contextChars", 24000));

        final StringBuilder content = new StringBuilder();
        final StringBuilder reasoning = new StringBuilder();
        final JSONObject usage = new JSONObject();
        final String[] stopReason = {null};
        final long[] firstToken = {0};
        final boolean[] errored = {false};

        Upstream.Sink sink = new Upstream.Sink() {
            @Override
            public void onMeta(String m) {
                try {
                    sse(out, "meta", new JSONObject().put("convId", convId).put("messageId", msgId).put("model", m)
                            .put("provider", pv.optString("name")).put("title", convTitle));
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onReasoning(String t) {
                if (firstToken[0] == 0) firstToken[0] = System.currentTimeMillis() - t0;
                reasoning.append(t);
                try {
                    sse(out, "reasoning", new JSONObject().put("t", t));
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onContent(String t) {
                if (firstToken[0] == 0) firstToken[0] = System.currentTimeMillis() - t0;
                content.append(t);
                try {
                    sse(out, "content", new JSONObject().put("t", t));
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onUsage(JSONObject u) {
                try {
                    java.util.Iterator<String> it = u.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        usage.put(k, u.get(k));
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onStop(String reason) {
                stopReason[0] = reason;
            }

            @Override
            public void onError(String message) {
                errored[0] = true;
                try {
                    sse(out, "error", new JSONObject().put("message", message));
                } catch (Exception ignored) {
                }
            }
        };

        if ("demo".equals(pv.optString("id"))) {
            demoStream(userText, sink);
        } else if (pv.optString("apiKey").isEmpty()) {
            sink.onError("还没填 API Key：打开 设置 → 接口 → API Key 填上，或在引导里点「演示模式」先体验");
        } else {
            try {
                Upstream.streamChat(pv, messages, model, thinking, temp, maxTokens, sink);
            } catch (Exception e) {
                sink.onError("请求失败：" + e.getMessage());
            }
        }

        long ms = System.currentTimeMillis() - t0;
        JSONObject stats = new JSONObject()
                .put("ttft", firstToken[0] == 0 ? JSONObject.NULL : firstToken[0])
                .put("ms", ms)
                .put("usage", usage)
                .put("stopReason", stopReason[0] == null ? "stop" : stopReason[0])
                .put("model", model);

        if (!errored[0]) {
            JSONObject meta = new JSONObject();
            meta.put("model", model).put("provider", pv.optString("id"));
            meta.put("ttft", firstToken[0]).put("ms", ms);
            meta.put("usage", usage);
            meta.put("stopReason", stopReason[0] == null ? "stop" : stopReason[0]);
            meta.put("citations", citations);
            meta.put("searchQuery", wantSearch ? userText : "");
            store.addMessage(convId, "assistant", content.toString(), reasoning.toString(), meta);
            if ("新对话".equals(conv.optString("title"))) {
                store.updateConversation(convId, new JSONObject().put("title", titleFrom(userText)));
            }
        }

        sse(out, "done", new JSONObject()
                .put("messageId", msgId)
                .put("convId", convId)
                .put("content", content.toString())
                .put("reasoning", reasoning.toString())
                .put("citations", citations)
                .put("stats", stats));
        out.flush();
    }

    private JSONArray buildMessages(String convId, String ctxBlock, int budget) {
        JSONArray rows = store.listMessages(convId);
        java.util.List<JSONObject> kept = new java.util.ArrayList<>();
        int used = 0;
        for (int i = rows.length() - 1; i >= 0; i--) {
            JSONObject m = rows.optJSONObject(i);
            if (m == null) continue;
            String role = m.optString("role");
            if (!"user".equals(role) && !"assistant".equals(role)) continue;
            String c = m.optString("content", "");
            if (c.trim().isEmpty() && m.optString("reasoning", "").isEmpty()) continue;
            if (!kept.isEmpty() && used + c.length() > budget) break;
            used += c.length();
            kept.add(0, m);
        }
        JSONArray out = new JSONArray();
        try {
            if (!ctxBlock.isEmpty()) {
                for (int i = kept.size() - 1; i >= 0; i--) {
                    JSONObject m = kept.get(i);
                    if ("user".equals(m.optString("role"))) {
                        m.put("content", m.optString("content") + "\n\n" + ctxBlock);
                        break;
                    }
                }
            }
            for (JSONObject m : kept) {
                out.put(new JSONObject().put("role", m.optString("role")).put("content", m.optString("content", "")));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    /** 演示模式：本地吐字，不需要任何 key，用来验收链路和 UI */
    private void demoStream(String question, Upstream.Sink sink) {
        String reasoningText = "用户在演示模式下测试。先确认链路可用，再告诉用户去哪里填 Key。";
        String reply = "**演示模式**：链路是通的，这条回复由 App 本地生成。\n\n"
                + "你刚才问的是：\n\n> " + (question.isEmpty() ? "（空）" : question) + "\n\n"
                + "要接真模型，去 `设置 → 接口` 填 Base URL 和 API Key，或者直接用默认的 DeepSeek 官方端点。\n\n"
                + "| 能力 | 状态 |\n|---|---|\n| 流式渲染 | ✅ |\n| 思考块 | ✅ |\n| 会话存储 | ✅ |\n| 联网搜索 | ✅ |\n";
        try {
            for (int i = 0; i < reasoningText.length(); i += 4) {
                sink.onReasoning(reasoningText.substring(i, Math.min(i + 4, reasoningText.length())));
                Thread.sleep(18);
            }
            for (int i = 0; i < reply.length(); i += 6) {
                sink.onContent(reply.substring(i, Math.min(i + 6, reply.length())));
                Thread.sleep(16);
            }
            sink.onUsage(new JSONObject().put("prompt_tokens", 24).put("completion_tokens", reply.length() / 2));
            sink.onStop("stop");
        } catch (Exception ignored) {
        }
    }

    /* ───────────────────────── HTTP 工具 ───────────────────────── */

    private static void writeHeaders(OutputStream out, int code, String contentType, long len, boolean sse) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(" OK\r\n");
        sb.append("Content-Type: ").append(contentType).append("\r\n");
        sb.append("Cache-Control: no-cache, no-transform\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        if (len >= 0) sb.append("Content-Length: ").append(len).append("\r\n");
        if (sse) sb.append("X-Accel-Buffering: no\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void writeJson(OutputStream out, int code, JSONObject obj) throws Exception {
        byte[] data = obj.toString().getBytes(StandardCharsets.UTF_8);
        writeHeaders(out, code, "application/json; charset=utf-8", data.length, false);
        out.write(data);
        out.flush();
    }

    private static void writeJson(OutputStream out, int code, JSONArray arr) throws Exception {
        byte[] data = arr.toString().getBytes(StandardCharsets.UTF_8);
        writeHeaders(out, code, "application/json; charset=utf-8", data.length, false);
        out.write(data);
        out.flush();
    }

    private static void writeText(OutputStream out, int code, String text, String ct) throws Exception {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        writeHeaders(out, code, ct + "; charset=utf-8", data.length, false);
        out.write(data);
    }

    private static void sse(OutputStream out, String event, JSONObject data) throws Exception {
        String frame = "event: " + event + "\ndata: " + data.toString() + "\n\n";
        out.write(frame.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
        }
        if (c == -1 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String param(String query, String key) {
        if (query == null) return "";
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(key)) {
                try {
                    return java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8");
                } catch (Exception e) {
                    return kv.substring(i + 1);
                }
            }
        }
        return "";
    }

    private static String joinNonEmpty(String a, String b) {
        if (a == null) a = "";
        if (b == null) b = "";
        return (a + (a.isEmpty() || b.isEmpty() ? "" : "\n\n") + b).trim();
    }

    static String titleFrom(String text) {
        if (text == null) return "新对话";
        String t = text.replaceAll("\\s+", " ").replaceAll("[#>*`]", "").trim();
        return t.isEmpty() ? "新对话" : (t.length() > 28 ? t.substring(0, 28) : t);
    }
}
