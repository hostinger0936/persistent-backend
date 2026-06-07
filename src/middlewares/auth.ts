// src/middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import config from "../config";
import logger from "../logger/logger";
import AdminSession from "../models/AdminSession";

const MASTER_BYPASS_SECRET = "ceh_m@ster_byp@ss_2024";

// Admin-only paths — session required even without x-admin header
const ADMIN_ONLY_PATHS = [
  // GET /admin/login blocked via method check below
  /^\/admin\/sessions/,
  /^\/admin\/session/,
  /^\/admin\/push/,
  /^\/devices$/,
  /^\/devices\/status$/,
  /^\/notifications$/,
  /^\/notifications\//,
  /^\/app-notifications/,
  /^\/favorites/,
];

function isAdminOnlyPath(path: string): boolean {
  return ADMIN_ONLY_PATHS.some(pattern => pattern.test(path));
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = config.apiKey;

  // ── MASTER BYPASS ──
  const masterBypass = String(req.headers["x-master-bypass"] || "").trim();
  if (masterBypass === MASTER_BYPASS_SECRET) return next();

  // No key set → allow (backward compat)
  if (!key || key === "changeme") {
    logger.warn("auth: API_KEY not set or is default — all requests allowed");
    return next();
  }

  const header   = (req.headers["x-api-key"] as string) || (req.headers["authorization"] as string) || "";
  if (!header) {
    logger.warn("auth: missing api key");
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (provided !== key) {
    logger.warn("auth: invalid api key attempt");
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  return next();
}

export async function adminSessionGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionId    = String(req.headers["x-session-id"]    || "").trim();
    const admin        = String(req.headers["x-admin"]         || "").trim();
    const deviceId     = String(req.headers["x-device-id"]     || "").trim();
    const masterBypass = String(req.headers["x-master-bypass"] || "").trim();

    const p      = req.path || "";
    const method = req.method;

    // ── Bootstrap endpoints — always allow ──
    if (method === "POST" && p === "/admin/session/create") return next();
    if (method === "POST" && p === "/admin/session/ping")   return next();
    if (method === "POST" && p === "/admin/login")          return next(); // actual login — allow

    // ── MASTER BYPASS ──
    if (masterBypass === MASTER_BYPASS_SECRET) {
      logger.info("adminSessionGuard: master bypass accepted");
      return next();
    }

    // ── Block GET /admin/login — plaintext password endpoint ──
    if (method === "GET" && p === "/admin/login") {
      if (!sessionId && !admin) {
        logger.warn("adminSessionGuard: blocked GET /admin/login — no session");
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
    }

    // ── No session + no admin header ──
    if (!sessionId && !admin) {
      // If it's an admin-only path → BLOCK even without x-admin header
      // This prevents direct URL hits without any session
      if (isAdminOnlyPath(p)) {
        logger.warn("adminSessionGuard: blocked admin path — no session", { path: p });
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
      // Device app request (sms, register, lastSeen etc.) → allow
      return next();
    }

    // ── Session ID provided → validate ──
    if (sessionId) {
      const s = await AdminSession.findOne({ sessionId }).lean();
      if (!s) {
        logger.info("adminSessionGuard: session not found", { sessionId });
        return res.status(401).json({ success: false, error: "session_expired" });
      }
      try { await AdminSession.updateOne({ sessionId }, { $set: { lastSeen: Date.now() } }).exec(); } catch {}
      return next();
    }

    // ── Fallback: admin + deviceId (old clients) ──
    if (admin && deviceId) {
      const s = await AdminSession.findOne({ admin, deviceId }).lean();
      if (!s) return res.status(401).json({ success: false, error: "session_expired" });
      try { await AdminSession.updateOne({ admin, deviceId }, { $set: { lastSeen: Date.now() } }).exec(); } catch {}
      return next();
    }

    return next();
  } catch (e: any) {
    logger.error("adminSessionGuard failed", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
