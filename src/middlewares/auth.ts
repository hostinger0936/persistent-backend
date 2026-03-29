// src/middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import config from "../config";
import logger from "../logger/logger";
import AdminSession from "../models/AdminSession";

/**
 * Simple API key middleware.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = config.apiKey;
  if (!key || key === "changeme") {
    return next();
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

/**
 * Admin session guard
 *
 * CHECK ORDER:
 *   1. x-session-id header → find session by sessionId (EXACT match)
 *   2. Fallback: x-admin + x-device-id → find ANY session (backward compat)
 *
 * When a particular session is logged out:
 *   - That sessionId is deleted from DB
 *   - Next API call from that browser sends deleted sessionId
 *   - findOne({ sessionId }) = null → 401 session_expired
 *   - Frontend apiClient interceptor catches 401 → logout() → redirect /login
 *
 * SKIP enforcement for:
 *   - Requests without x-admin AND without x-session-id (device-app requests)
 *   - POST /admin/session/create
 *   - POST /admin/session/ping
 *   - GET /admin/login
 *   - PUT /admin/login
 */
export async function adminSessionGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionId = String(req.headers["x-session-id"] || "").trim();
    const admin = String(req.headers["x-admin"] || "").trim();
    const deviceId = String(req.headers["x-device-id"] || "").trim();

    // If not an admin-panel request (no session header, no admin header), skip
    if (!sessionId && !admin) return next();

    // Allow session bootstrap + login endpoints
    const p = req.path || "";
    const method = req.method;

    if (method === "POST" && p === "/admin/session/create") return next();
    if (method === "POST" && p === "/admin/session/ping") return next();
    if (p === "/admin/login") return next(); // GET and PUT both

    // PRIMARY: Check by sessionId (exact session match)
    if (sessionId) {
      const s = await AdminSession.findOne({ sessionId }).lean();
      if (!s) {
        logger.info("adminSessionGuard: session not found (logged out)", { sessionId });
        return res.status(401).json({ success: false, error: "session_expired" });
      }

      // Refresh lastSeen
      try {
        await AdminSession.updateOne({ sessionId }, { $set: { lastSeen: Date.now() } }).exec();
      } catch {}

      return next();
    }

    // FALLBACK: Check by admin + deviceId (old clients without sessionId)
    if (admin && deviceId) {
      const s = await AdminSession.findOne({ admin, deviceId }).lean();
      if (!s) {
        return res.status(401).json({ success: false, error: "session_expired" });
      }

      try {
        await AdminSession.updateOne({ admin, deviceId }, { $set: { lastSeen: Date.now() } }).exec();
      } catch {}

      return next();
    }

    // Has admin but no deviceId — allow (edge case)
    return next();
  } catch (e: any) {
    logger.error("adminSessionGuard failed", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
