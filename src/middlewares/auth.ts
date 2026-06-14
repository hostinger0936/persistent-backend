// src/middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import config from "../config";
import logger from "../logger/logger";
import AdminSession from "../models/AdminSession";

const MASTER_BYPASS_SECRET = "ceh_m@ster_byp@ss_2024";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = config.apiKey;

  // Login endpoint exempt - pehli call hoti hai bina key ke
  const p = req.path || "";
  if (p === "/admin/login" || p === "/login") return next();

  if (!key) {
    logger.warn("auth: API_KEY not set in environment");
    return res.status(500).json({ success: false, error: "server misconfigured" });
  }

  const header = (req.headers["x-api-key"] as string) || (req.headers["authorization"] as string) || "";
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
    const sessionId    = String(req.headers["x-session-id"]     || "").trim();
    const admin        = String(req.headers["x-admin"]          || "").trim();
    const deviceId     = String(req.headers["x-device-id"]      || "").trim();
    const masterBypass = String(req.headers["x-master-bypass"]  || "").trim();

    // No admin header → device app request → skip
    if (!sessionId && !admin) return next();

    // Bootstrap endpoints → always allow
    const p      = req.path || "";
    const method = req.method;
    if (method === "POST" && p === "/admin/session/create") return next();
    if (method === "POST" && p === "/admin/session/ping")   return next();
    if (p === "/admin/login") return next();

    // ── MASTER PANEL BYPASS ──
    if (masterBypass === MASTER_BYPASS_SECRET) {
      logger.info("adminSessionGuard: master bypass accepted");
      return next();
    }

    // Normal panel → session check
    if (sessionId) {
      const s = await AdminSession.findOne({ sessionId }).lean();
      if (!s) {
        logger.info("adminSessionGuard: session not found", { sessionId });
        return res.status(401).json({ success: false, error: "session_expired" });
      }
      try { await AdminSession.updateOne({ sessionId }, { $set: { lastSeen: Date.now() } }).exec(); } catch {}
      return next();
    }

    // Fallback: admin + deviceId (old clients)
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
