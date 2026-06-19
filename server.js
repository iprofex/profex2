#!/usr/bin/env node
// Flixy Panel — Telegram Proxy Server
// Host on Render / Railway / Fly.io / any Node 18+ host.
// Credentials are in .env — edit that file before deploying.

import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const PROXY_SECRET = process.env.PROXY_SECRET ?? "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 3001);

// ── Crypto helpers ────────────────────────────────────────────────────────────
function deriveKey(secret) {
  return crypto.pbkdf2Sync(secret, "flixy-panel", 100_000, 32, "sha256");
}

function decryptBody(raw, secret) {
  const key = deriveKey(secret);
  const iv = Buffer.from(raw.iv, "base64");
  const ctWithTag = Buffer.from(raw.d, "base64");
  const authTag = ctWithTag.subarray(-16);
  const ciphertext = ctWithTag.subarray(0, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

// ── CORS helper ───────────────────────────────────────────────────────────────
function applyCors(req, res) {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function checkOrigin(req, res) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = req.headers.origin ?? req.headers.referer ?? "";
  if (!ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    res.status(403).json({ ok: false, error: "Origin not allowed" });
    return false;
  }
  return true;
}

app.use(express.json());

// Preflight
app.options("/telegram-send", (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

// ── Main route ────────────────────────────────────────────────────────────────
app.post("/telegram-send", upload.single("file"), async (req, res) => {
  applyCors(req, res);
  if (!checkOrigin(req, res)) return;
  if (!BOT_TOKEN || !CHAT_ID) return res.json({ ok: true });

  let text = "";
  const file = req.file;

  if (!file) {
    const raw = req.body;
    if (raw?.d && raw?.iv) {
      // AES-GCM encrypted payload
      if (!PROXY_SECRET) return res.status(400).json({ ok: false, error: "No PROXY_SECRET configured" });
      try {
        text = decryptBody(raw, PROXY_SECRET).text ?? "";
      } catch {
        return res.status(400).json({ ok: false, error: "Decryption failed — check PROXY_SECRET matches frontend" });
      }
    } else {
      // Plain JSON — still verify secret
      if (PROXY_SECRET && raw?.secret !== PROXY_SECRET) {
        return res.status(403).json({ ok: false, error: "Unauthorized" });
      }
      text = raw?.text ?? "";
    }
  } else {
    // Multipart file upload — verify secret field
    if (PROXY_SECRET && req.body?.secret !== PROXY_SECRET) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }
    text = req.body?.caption ?? req.body?.text ?? "";
  }

  try {
    if (file) {
      const form = new FormData();
      form.append("chat_id", CHAT_ID);
      form.append(
        "document",
        new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
        file.originalname || "file.apk"
      );
      if (text) form.append("caption", text);
      form.append("parse_mode", "HTML");

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form,
      });
    } else if (text) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Telegram proxy running on port ${PORT}`);
  console.log(`   Origin restriction: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "none (all allowed)"}`);
  console.log(`   Secret auth: ${PROXY_SECRET ? "enabled" : "disabled"}`);
});
