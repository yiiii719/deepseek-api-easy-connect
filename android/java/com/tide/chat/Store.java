package com.tide.chat;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * 极简 JSON 文件存储：设置 / 会话 / 消息 / 附件。
 * 单人本地应用，不上 SQLite，读写都加锁，避免多线程打架。
 */
public class Store {

    private static final Object LOCK = new Object();
    private final File dir;
    private final File convsFile;
    private final File settingsFile;

    public Store(Context ctx) {
        dir = new File(ctx.getFilesDir(), "store");
        if (!dir.exists()) dir.mkdirs();
        convsFile = new File(dir, "conversations.json");
        settingsFile = new File(dir, "settings.json");
    }

    /* ---------------- 基础读写 ---------------- */

    private String read(File f) {
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.e("TIDE", "read fail " + f, e);
            return null;
        }
    }

    private void write(File f, String s) {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.e("TIDE", "write fail " + f, e);
        }
    }

    private JSONObject readObj(File f) {
        String s = read(f);
        if (s == null || s.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private JSONArray readArr(File f) {
        String s = read(f);
        if (s == null || s.isEmpty()) return new JSONArray();
        try {
            return new JSONArray(s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private File msgFile(String convId) {
        File d = new File(dir, "msg");
        if (!d.exists()) d.mkdirs();
        return new File(d, convId + ".json");
    }

    /* ---------------- 设置 ---------------- */

    public JSONObject getSettings() {
        synchronized (LOCK) {
            return readObj(settingsFile);
        }
    }

    public JSONObject patchSettings(JSONObject patch) {
        synchronized (LOCK) {
            JSONObject cur = readObj(settingsFile);
            try {
                java.util.Iterator<String> it = patch.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if ("providers".equals(k)) continue;
                    cur.put(k, patch.get(k));
                }
                // providers 按 id 合并
                if (patch.has("providers")) {
                    JSONArray incoming = patch.optJSONArray("providers");
                    JSONArray merged = cur.optJSONArray("providers");
                    if (merged == null) merged = new JSONArray();
                    if (incoming != null) {
                        for (int i = 0; i < incoming.length(); i++) {
                            JSONObject inc = incoming.optJSONObject(i);
                            if (inc == null || !inc.has("id")) continue;
                            String id = inc.optString("id");
                            boolean replaced = false;
                            for (int j = 0; j < merged.length(); j++) {
                                JSONObject old = merged.optJSONObject(j);
                                if (old != null && id.equals(old.optString("id"))) {
                                    java.util.Iterator<String> kk = inc.keys();
                                    while (kk.hasNext()) {
                                        String key = kk.next();
                                        old.put(key, inc.get(key));
                                    }
                                    merged.put(j, old);
                                    replaced = true;
                                    break;
                                }
                            }
                            if (!replaced) merged.put(inc);
                        }
                    }
                    cur.put("providers", merged);
                }
                write(settingsFile, cur.toString());
            } catch (Exception e) {
                Log.e("TIDE", "patchSettings", e);
            }
            return cur;
        }
    }

    /* ---------------- 会话 ---------------- */

    public JSONArray listConversations() {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            JSONArray out = new JSONArray();
            // 置顶优先 + 更新时间倒序
            java.util.List<JSONObject> list = new java.util.ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) list.add(o);
            }
            list.sort(new java.util.Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    boolean pa = a.optBoolean("pinned");
                    boolean pb = b.optBoolean("pinned");
                    if (pa != pb) return pa ? -1 : 1;
                    return Long.compare(b.optLong("updatedAt"), a.optLong("updatedAt"));
                }
            });
            for (JSONObject o : list) out.put(o);
            return out;
        }
    }

    public JSONObject getConversation(String id) {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && id.equals(o.optString("id"))) return o;
            }
            return null;
        }
    }

    public JSONObject createConversation(String title, String model, String provider) {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            JSONObject o = new JSONObject();
            long now = System.currentTimeMillis();
            try {
                o.put("id", UUID.randomUUID().toString());
                o.put("title", title == null || title.isEmpty() ? "新对话" : title);
                o.put("createdAt", now);
                o.put("updatedAt", now);
                o.put("pinned", false);
                o.put("model", model == null ? "" : model);
                o.put("provider", provider == null ? "" : provider);
            } catch (Exception ignored) {
            }
            arr.put(o);
            write(convsFile, arr.toString());
            return o;
        }
    }

    public JSONObject updateConversation(String id, JSONObject patch) {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || !id.equals(o.optString("id"))) continue;
                try {
                    if (patch.has("title")) o.put("title", patch.optString("title"));
                    if (patch.has("pinned")) o.put("pinned", patch.optBoolean("pinned"));
                    if (patch.has("model")) o.put("model", patch.optString("model"));
                    if (patch.has("provider")) o.put("provider", patch.optString("provider"));
                    o.put("updatedAt", System.currentTimeMillis());
                    arr.put(i, o);
                } catch (Exception ignored) {
                }
                write(convsFile, arr.toString());
                return o;
            }
            return null;
        }
    }

    public boolean deleteConversation(String id) {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && id.equals(o.optString("id"))) continue;
                out.put(o);
            }
            write(convsFile, out.toString());
            File mf = msgFile(id);
            if (mf.exists()) mf.delete();
            return true;
        }
    }

    public void touchConversation(String id) {
        synchronized (LOCK) {
            JSONArray arr = readArr(convsFile);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || !id.equals(o.optString("id"))) continue;
                try {
                    o.put("updatedAt", System.currentTimeMillis());
                    arr.put(i, o);
                } catch (Exception ignored) {
                }
            }
            write(convsFile, arr.toString());
        }
    }

    /* ---------------- 消息 ---------------- */

    public JSONArray listMessages(String convId) {
        synchronized (LOCK) {
            JSONArray arr = readArr(msgFile(convId));
            // 补 seq（老数据没有就按顺序）
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && !o.has("seq")) {
                    try {
                        o.put("seq", i + 1);
                    } catch (Exception ignored) {
                    }
                }
            }
            return arr;
        }
    }

    public JSONObject addMessage(String convId, String role, String content, String reasoning, JSONObject meta) {
        synchronized (LOCK) {
            JSONArray arr = readArr(msgFile(convId));
            JSONObject o = new JSONObject();
            try {
                o.put("id", UUID.randomUUID().toString());
                o.put("convId", convId);
                o.put("role", role);
                o.put("content", content == null ? "" : content);
                o.put("reasoning", reasoning == null ? "" : reasoning);
                o.put("createdAt", System.currentTimeMillis());
                o.put("seq", arr.length() + 1);
                o.put("meta", meta == null ? new JSONObject() : meta);
            } catch (Exception ignored) {
            }
            arr.put(o);
            write(msgFile(convId), arr.toString());
            touchConversation(convId);
            return o;
        }
    }

    public boolean deleteMessage(String convId, String msgId) {
        synchronized (LOCK) {
            JSONArray arr = readArr(msgFile(convId));
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && msgId.equals(o.optString("id"))) continue;
                out.put(o);
            }
            write(msgFile(convId), out.toString());
            return true;
        }
    }

    /** 从某条消息起（含）整段截断，用于编辑重发 */
    public void truncateFrom(String convId, String msgId) {
        synchronized (LOCK) {
            JSONArray arr = readArr(msgFile(convId));
            int at = -1;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && msgId.equals(o.optString("id"))) {
                    at = i;
                    break;
                }
            }
            if (at < 0) return;
            JSONArray out = new JSONArray();
            for (int i = 0; i < at; i++) out.put(arr.optJSONObject(i));
            write(msgFile(convId), out.toString());
        }
    }

    /* ---------------- 附件 ---------------- */

    public JSONObject saveAttachment(String name, String text, int size) {
        synchronized (LOCK) {
            JSONObject o = new JSONObject();
            try {
                String id = UUID.randomUUID().toString();
                o.put("id", id);
                o.put("name", name);
                o.put("chars", text.length());
                o.put("size", size);
                JSONObject rec = new JSONObject();
                rec.put("name", name);
                rec.put("text", text);
                File d = new File(dir, "att");
                if (!d.exists()) d.mkdirs();
                write(new File(d, id + ".json"), rec.toString());
                return o;
            } catch (Exception e) {
                return null;
            }
        }
    }

    public JSONObject getAttachment(String id) {
        synchronized (LOCK) {
            File d = new File(dir, "att");
            File f = new File(d, id + ".json");
            if (!f.exists()) return null;
            return readObj(f);
        }
    }
}
