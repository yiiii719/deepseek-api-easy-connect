package com.tide.chat;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** 附件正文抽取：纯文本系 + docx（zip + XML）。PDF/图片在 App 内不解析。 */
public class Extract {

    public static String text(String name, byte[] data) {
        String lower = name == null ? "" : name.toLowerCase();
        try {
            if (lower.endsWith(".docx")) return docx(data);
            if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown")
                    || lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".json")
                    || lower.endsWith(".log") || lower.endsWith(".yml") || lower.endsWith(".yaml")
                    || lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".py")
                    || lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".go")
                    || lower.endsWith(".rs") || lower.endsWith(".c") || lower.endsWith(".cpp")
                    || lower.endsWith(".h") || lower.endsWith(".css") || lower.endsWith(".html")
                    || lower.endsWith(".xml") || lower.endsWith(".sql") || lower.endsWith(".sh")
                    || lower.endsWith(".ini") || lower.endsWith(".conf")) {
                return new String(data, StandardCharsets.UTF_8).replace("\u0000", "");
            }
            // 未知类型：能当文本读就试一下
            String guess = new String(data, StandardCharsets.UTF_8);
            int nul = 0;
            for (int i = 0; i < guess.length(); i++) if (guess.charAt(i) == 0) nul++;
            if (data.length < 2_000_000 && nul * 100 < guess.length()) return guess;
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String docx(byte[] data) throws Exception {
        ZipInputStream zis = new ZipInputStream(new java.io.ByteArrayInputStream(data));
        ZipEntry e;
        String xml = null;
        while ((e = zis.getNextEntry()) != null) {
            if ("word/document.xml".equals(e.getName())) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = zis.read(buf)) > 0) bos.write(buf, 0, n);
                xml = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                break;
            }
        }
        zis.close();
        if (xml == null) return null;
        String text = xml
                .replaceAll("<w:tab[^>]*/>", "\t")
                .replaceAll("<w:br[^>]*/>", "\n")
                .replaceAll("</w:p>", "\n")
                .replaceAll("</w:tr>", "\n")
                .replaceAll("</w:tc>", "\t")
                .replaceAll("<[^>]+>", "");
        text = unescape(text).replaceAll("\n{3,}", "\n\n").trim();
        return text;
    }

    private static String unescape(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&apos;", "'")
                .replace("&nbsp;", " ").replace("&amp;", "&");
    }
}
