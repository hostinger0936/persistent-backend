// src/middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import config from "../config";
import logger from "../logger/logger";
import AdminSession from "../models/AdminSession";

/**
 * Simple API key middleware.
 * - If config.apiKey is "changeme" or empty, middleware is a no-op (allows all).
 * - Otherwise expects header `x-api-key: <key>` or `Authorization: Bearer <key>`
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

  // passed
  return next();
}

/**
 * Admin session guard (Option A: server-enforced sessions)
 *
 * IMPORTANT:
 * - Only enforces when request includes BOTH:
 *   - x-admin
 *   - x-device-id
 *   (So normal device-app requests won't break.)
 *
 * - Allows these endpoints without prior session:
 *   - POST /api/admin/session/create
 *   - POST /api/admin/session/ping
 *
 * Behavior:
 * - If admin+deviceId session not found in DB => 401
 */
export async function adminSessionGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = String(req.headers["x-admin"] || "").trim();
    const deviceId = String(req.headers["x-device-id"] || "").trim();

    // If not an admin-panel request, do not enforce (keeps device apps working)
    if (!admin || !deviceId) return next();

    // Allow session bootstrap endpoints
    const p = req.path || "";
    const isCreate = req.method === "POST" && p === "/admin/session/create";
    const isPing = req.method === "POST" && p === "/admin/session/ping";
    if (isCreate || isPing) return next();

    // Verify session exists
    const s = await AdminSession.findOne({ admin, deviceId }).lean();
    if (!s) {
      return res.status(401).json({ success: false, error: "session_expired" });
    }

    // Optional: refresh lastSeen to keep active (safe)
    try {
      await AdminSession.updateOne({ admin, deviceId }, { $set: { lastSeen: Date.now() } }).exec();
    } catch {
      // ignore refresh errors
    }

    return next();
  } catch (e: any) {
    logger.error("adminSessionGuard failed", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}