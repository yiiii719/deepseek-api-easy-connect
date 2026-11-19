package com.tide.chat;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 上游：OpenAI 兼容的 /chat/completions（流式）+ /models + Bing RSS 搜索。
 * 只用 HttpURLConnection，零第三方依赖，APK 才 30KB。
 */
public class Upstream {

    public interface Sink {
        void onMeta(String model);

        void onReasoning(String t);

        void onContent(String t);

        void onUsage(JSONObject usage);

        void onStop(String reason);

        void onError(String message);
    }

    /** org.json 的坑：字段存在但值是 null 时，optString 会返回字符串 "null"。统一走这里。 */
    static String str(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return "";
        String v = o.optString(key, "");
        return "null".equals(v) ? "" : v;
    }

    static String joinUrl(String base, String path) {        if (base == null) base = "";
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (!path.startsWith("/")) path = "/" + path;
        return base + path;
    }

    private static HttpURLConnection open(String url, String apiKey, int connectTimeout, int readTimeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(connectTimeout);
        c.setReadTimeout(readTimeout);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "text/event-stream");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("User-Agent", "Tide/1.0 (Android)");
        if (apiKey != null && !apiKey.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + apiKey);
        return c;
    }

    /** 流式对话。在调用方线程执行（LocalServer 用独立线程），逐块回调。 */
    public static void streamChat(JSONObject cfg, JSONArray messages, String model, boolean thinking,
                                  double temperature, int maxTokens, Sink sink) {
        HttpURLConnection c = null;
        try {
            String base = cfg.optString("baseUrl", "https://api.deepseek.com/v1");
            String key = cfg.optString("apiKey", "");
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", messages);
            body.put("stream", true);
            body.put("stream_options", new JSONObject().put("include_usage", true));
            body.put("temperature", temperature);
            body.put("max_tokens", maxTokens);
            if (cfg.optBoolean("effortSupported", false)) {
                body.put("effort", thinking ? "high" : "low");
            }
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

            c = open(joinUrl(base, "/chat/completions"), key, 20000, 180000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(payload);
            }

            int code = c.getResponseCode();
            if (code >= 400) {
                String err = readAll(c.getErrorStream());
                sink.onError("上游 " + code + "：" + shortErr(err));
                return;
            }
            String ct = c.getContentType() == null ? "" : c.getContentType();
            if (!ct.contains("event-stream")) {
                // 有的兼容层不认 stream，直接回整包
                String all = readAll(c.getInputStream());
                JSONObject j = new JSONObject(all);
                JSONObject msg = j.optJSONArray("choices") == null ? null
                        : j.optJSONArray("choices").optJSONObject(0).optJSONObject("message");
                if (msg != null) {
                    String rs = str(msg, "reasoning_content");
                    if (!rs.isEmpty()) sink.onReasoning(rs);
                    String cs = str(msg, "content");
                    if (!cs.isEmpty()) sink.onContent(cs);
                }
                if (j.has("usage")) sink.onUsage(j.getJSONObject("usage"));
                sink.onStop("stop");
                return;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8), 8192);
            String line;
            String lastModel = model;
            while ((line = br.readLine()) != null) {
                if (line.isEmpty() || line.startsWith(":")) continue;
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.isEmpty()) continue;
                if ("[DONE]".equals(data)) {
                    sink.onStop("done");
                    break;
                }
                JSONObject j;
                try {
                    j = new JSONObject(data);
                } catch (Exception e) {
                    continue;
                }
                if (j.has("model")) {
                    String m = j.optString("model");
                    if (!m.isEmpty() && !m.equals(lastModel)) {
                        lastModel = m;
                        sink.onMeta(m);
                    }
                }
                if (j.has("error")) {
                    sink.onError(j.optJSONObject("error") != null
                            ? j.optJSONObject("error").optString("message", "上游报错")
                            : j.optString("error"));
                    break;
                }
                JSONArray choices = j.optJSONArray("choices");
                if (choices != null && choices.length() > 0) {
                    JSONObject ch = choices.optJSONObject(0);
                    JSONObject d = ch == null ? null : ch.optJSONObject("delta");
                    if (d != null) {
                        String r = str(d, "reasoning_content");
                        if (r.isEmpty()) r = str(d, "reasoning");
                        if (!r.isEmpty()) sink.onReasoning(r);
                        String t = str(d, "content");
                        if (!t.isEmpty()) sink.onContent(t);
                    }
                    String fr = ch == null ? null : str(ch, "finish_reason");
                    if (fr != null && !fr.isEmpty()) sink.onStop(fr);
                }
                if (j.has("usage") && !j.isNull("usage")) sink.onUsage(j.getJSONObject("usage"));
            }
        } catch (Exception e) {
            Log.e("TIDE", "streamChat", e);
            sink.onError("连接上游失败：" + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 只测首字节：打一发 1 token 的请求，读到第一块就断开 */
    public static long bench(JSONObject cfg, String model) {
        HttpURLConnection c = null;
        try {
            String base = cfg.optString("baseUrl", "https://api.deepseek.com/v1");
            String key = cfg.optString("apiKey", "");
            JSONObject body = new JSONObject();
            body.put("model", model);
            JSONArray msgs = new JSONArray();
            msgs.put(new JSONObject().put("role", "user").put("content", "hi"));
            body.put("messages", msgs);
            body.put("stream", true);
            body.put("max_tokens", 1);
            body.put("temperature", 0);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

            c = open(joinUrl(base, "/chat/completions"), key, 15000, 30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(payload.length);
            long t0 = System.currentTimeMillis();
            try (OutputStream os = c.getOutputStream()) {
                os.write(payload);
            }
            int code = c.getResponseCode();
            if (code >= 400) return -1;
            InputStream in = c.getInputStream();
            byte[] buf = new byte[256];
            int n = in.read(buf);
            long dt = System.currentTimeMillis() - t0;
            return n > 0 ? dt : -1;
        } catch (Exception e) {
            return -1;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public static JSONArray listModels(JSONObject cfg) {
        HttpURLConnection c = null;
        try {
            String base = cfg.optString("baseUrl", "https://api.deepseek.com/v1");
            String key = cfg.optString("apiKey", "");
            c = open(joinUrl(base, "/models"), key, 8000, 12000);
            c.setRequestMethod("GET");
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() >= 400) return null;
            String all = readAll(c.getInputStream());
            JSONObject j = new JSONObject(all);
            JSONArray data = j.optJSONArray("data");
            JSONArray out = new JSONArray();
            if (data != null) {
                for (int i = 0; i < data.length(); i++) {
                    JSONObject o = data.optJSONObject(i);
                    if (o != null && o.has("id")) out.put(o.optString("id"));
                }
            }
            return out;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Bing 的 RSS 出口：免 key、结构化。中文长句先蒸馏成关键词再搜。 */
    public static JSONArray search(String query, int limit) {
        JSONArray out = new JSONArray();
        HttpURLConnection c = null;
        try {
            String q = distill(query);
            String url = "https://cn.bing.com/search?q=" + URLEncoder.encode(q, "UTF-8") + "&format=rss&mkt=zh-CN&setlang=zh-Hans";
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(9000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36");
            c.setRequestProperty("Accept", "application/rss+xml, application/xml, text/xml");
            if (c.getResponseCode() >= 400) return out;
            String xml = readAll(c.getInputStream());
            Matcher m = Pattern.compile("<item>([\\s\\S]*?)</item>").matcher(xml);
            while (m.find() && out.length() < limit) {
                String block = m.group(1);
                String title = xmlTag(block, "title");
                String link = xmlTag(block, "link");
                String desc = xmlTag(block, "description");
                if (link == null || !link.startsWith("http")) continue;
                JSONObject o = new JSONObject();
                o.put("title", title == null || title.isEmpty() ? link : title);
                o.put("url", link);
                o.put("snippet", desc == null ? "" : desc);
                out.put(o);
            }
        } catch (Exception e) {
            Log.e("TIDE", "search", e);
        } finally {
            if (c != null) c.disconnect();
        }
        return out;
    }

    static String distill(String text) {
        String q = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        int cut = q.length();
        for (char ch : new char[]{'。', '？', '?', '！', '!', '\n'}) {
            int i = q.indexOf(ch);
            if (i > 0 && i < cut) cut = i;
        }
        q = q.substring(0, cut);
        q = q.replaceAll("^(请问一下|请问|麻烦你?|帮我|帮忙|我想知道|我想问|你好|嗨)[\\s,，]*", "");
        q = q.replaceAll("^(今天|今日|现在|当前|最近|近来|这几天)[\\s,，]*", "");
        q = q.replaceAll("(有什么|有哪些|是什么|是多少|是啥|怎么样|如何|多少钱)", " ");
        int comma = q.indexOf('，');
        if (comma > 0) q = q.substring(0, comma);
        q = q.replaceAll("[“”\"'《》`（）()【】\\[\\]]", " ").replaceAll("\\s+", " ").trim();
        if (q.isEmpty()) q = text == null ? "" : text;
        return q.length() > 64 ? q.substring(0, 64) : q;
    }

    private static String xmlTag(String block, String tag) {
        Matcher m = Pattern.compile("<" + tag + ">([\\s\\S]*?)</" + tag + ">").matcher(block);
        if (!m.find()) return null;
        return m.group(1)
                .replace("<![CDATA[", "").replace("]]>", "")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&#39;", "'")
                .replace("&apos;", "'").replace("&amp;", "&")
                .replaceAll("<[^>]+>", "").trim();
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[4096];
            int n;
            while ((n = br.read(buf)) > 0) sb.append(buf, 0, n);
        } catch (Exception ignored) {
        }
        return sb.toString();
    }

    private static String shortErr(String raw) {
        if (raw == null) return "";
        try {
            JSONObject j = new JSONObject(raw);
            JSONObject e = j.optJSONObject("error");
            if (e != null) return e.optString("message", raw);
        } catch (Exception ignored) {
        }
        return raw.length() > 200 ? raw.substring(0, 200) : raw;
    }
}
