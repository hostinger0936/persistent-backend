import express from "express";
import AdminSession from "../models/AdminSession";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function clean(v: any): string {
  return String(v ?? "").trim();
}

/** Extract client IP from request (handles proxies) */
function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded) && forwarded.length > 0) return String(forwarded[0]).trim();
  return req.socket?.remoteAddress || req.ip || "";
}

/**
 * Simple User-Agent parser — no external dependency.
 * Returns { browser, os } strings.
 */
function parseUserAgent(ua: string): { browser: string; os: string } {
  const s = ua || "";
  let browser = "Unknown";
  let os = "Unknown";

  // ── OS detection ──
  if (/Windows NT 10/i.test(s)) os = "Windows 10";
  else if (/Windows NT 11|Windows NT 10.*Build\/(2[2-9]|[3-9])/i.test(s)) os = "Windows 11";
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/Mac OS X (\d+[._]\d+)/i.test(s)) {
    const m = s.match(/Mac OS X (\d+[._]\d+)/i);
    os = `macOS ${m ? m[1].replace(/_/g, ".") : ""}`.trim();
  } else if (/Mac/i.test(s)) os = "macOS";
  else if (/Android (\d+(\.\d+)?)/i.test(s)) {
    const m = s.match(/Android (\d+(\.\d+)?)/i);
    os = `Android ${m ? m[1] : ""}`.trim();
  } else if (/Android/i.test(s)) os = "Android";
  else if (/iPhone OS (\d+[._]\d+)/i.test(s)) {
    const m = s.match(/iPhone OS (\d+[._]\d+)/i);
    os = `iOS ${m ? m[1].replace(/_/g, ".") : ""}`.trim();
  } else if (/iPad/i.test(s)) os = "iPadOS";
  else if (/iPhone|iOS/i.test(s)) os = "iOS";
  else if (/CrOS/i.test(s)) os = "Chrome OS";
  else if (/Linux/i.test(s)) os = "Linux";

  // ── Browser detection ──
  if (/Edg\/(\d+)/i.test(s)) {
    const m = s.match(/Edg\/(\d+)/i);
    browser = `Edge ${m ? m[1] : ""}`.trim();
  } else if (/OPR\/(\d+)/i.test(s) || /Opera\/(\d+)/i.test(s)) {
    const m = s.match(/OPR\/(\d+)/i) || s.match(/Opera\/(\d+)/i);
    browser = `Opera ${m ? m[1] : ""}`.trim();
  } else if (/SamsungBrowser\/(\d+)/i.test(s)) {
    const m = s.match(/SamsungBrowser\/(\d+)/i);
    browser = `Samsung Browser ${m ? m[1] : ""}`.trim();
  } else if (/Chrome\/(\d+)/i.test(s) && !/Edg/i.test(s)) {
    const m = s.match(/Chrome\/(\d+)/i);
    browser = `Chrome ${m ? m[1] : ""}`.trim();
  } else if (/Safari\/(\d+)/i.test(s) && !/Chrome/i.test(s)) {
    const m = s.match(/Version\/(\d+(\.\d+)?)/i);
    browser = `Safari ${m ? m[1] : ""}`.trim();
  } else if (/Firefox\/(\d+)/i.test(s)) {
    const m = s.match(/Firefox\/(\d+)/i);
    browser = `Firefox ${m ? m[1] : ""}`.trim();
  }

  return { browser, os };
}

/* ═══════════════════════════════════════════
   CREATE SESSION
   ═══════════════════════════════════════════
   Frontend sends: { admin, deviceId, sessionId, userAgent? }
   - sessionId is UUID generated per browser tab/login
   - If sessionId exists → update lastSeen (reconnect)
   - If new sessionId → create new row (new login)
*/

router.post("/session/create", async (req, res) => {
  try {
    const admin = clean(req.body.admin);
    const deviceId = clean(req.body.deviceId);
    const sessionId = clean(req.body.sessionId);

    if (!admin || !deviceId) {
      return res.status(400).json({ success: false, error: "missing admin or deviceId" });
    }

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "missing sessionId" });
    }

    const rawUa = clean(req.body.userAgent || req.headers["user-agent"] || "");
    const ip = getClientIp(req);
    const { browser, os } = parseUserAgent(rawUa);

    await AdminSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          admin,
          deviceId,
          userAgent: rawUa,
          ip,
          browser,
          os,
          lastSeen: Date.now(),
        },
      },
      { upsert: true, new: true },
    );

    logger.info("admin session created/updated", { sessionId, admin, deviceId, browser, os, ip });

    // Broadcast to admin panels
    try {
      wsService.broadcastAdminEvent("admin_session:created", {
        sessionId,
        admin,
        deviceId,
        browser,
        os,
        ip,
        lastSeen: Date.now(),
      });
    } catch (_) {}

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("create session failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   PING (keep session alive)
   ═══════════════════════════════════════════ */

router.post("/session/ping", async (req, res) => {
  try {
    const admin = clean(req.body.admin);
    const deviceId = clean(req.body.deviceId);
    const sessionId = clean(req.body.sessionId);

    const filter = sessionId
      ? { sessionId }
      : { admin, deviceId };

    await AdminSession.findOneAndUpdate(
      filter,
      { $set: { lastSeen: Date.now() } },
    );

    // Broadcast ping to admin panels
    try {
      wsService.broadcastAdminEvent("admin_session:ping", {
        sessionId,
        admin,
        deviceId,
        lastSeen: Date.now(),
      });
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   LIST ALL SESSIONS
   ═══════════════════════════════════════════
   Returns ALL individual sessions — no merging.
*/

router.get("/sessions", async (_req, res) => {
  try {
    const list = await AdminSession.find()
      .sort({ lastSeen: -1 })
      .lean();

    return res.json(list);
  } catch (e) {
    return res.status(500).json([]);
  }
});

/* ═══════════════════════════════════════════
   LOGOUT BY SESSION ID
   ═══════════════════════════════════════════
   DELETE /sessions/by-session/:sessionId
*/

router.delete("/sessions/by-session/:sessionId", async (req, res) => {
  try {
    const sessionId = clean(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ success: false, error: "missing sessionId" });
    }

    const doc = await AdminSession.findOneAndDelete({ sessionId }).lean();

    if (doc) {
      const did = clean((doc as any).deviceId);
      // Send force_logout to that specific browser
      try {
        await wsService.sendToAdminDevice(did || "__ADMIN__", {
          type: "force_logout",
          sessionId,
        });
        logger.info("Sent force_logout for session", { sessionId, deviceId: did });
      } catch (wsErr) {
        logger.error("force_logout ws failed", wsErr);
      }

      // Broadcast deletion
      try {
        wsService.broadcastAdminEvent("admin_session:deleted", {
          sessionId,
          deviceId: did,
        });
      } catch (_) {}
    }

    return res.json({ success: true });
  } catch (e) {
    logger.error("logout by sessionId failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   LOGOUT BY DEVICE ID (backward compatible)
   ═══════════════════════════════════════════
   DELETE /sessions/:deviceId
   Deletes ALL sessions for that deviceId
*/

router.delete("/sessions/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    // Don't match UUID-looking strings as sessionId route
    // (sessionId route is /sessions/by-session/:id)
    await AdminSession.deleteMany({ deviceId });

    try {
      await wsService.sendToAdminDevice(deviceId, {
        type: "force_logout",
      });
      logger.info(`Sent force_logout to all sessions on device ${deviceId}`);
    } catch (wsErr) {
      logger.error("Failed to send force_logout", wsErr);
    }

    try {
      wsService.broadcastAdminEvent("admin_session:deleted", { deviceId });
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    logger.error("logout by deviceId failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   LOGOUT ALL
   ═══════════════════════════════════════════ */

router.delete("/sessions", async (_req, res) => {
  try {
    const sessions = await AdminSession.find().lean();

    for (const s of sessions) {
      const did = clean((s as any).deviceId);
      if (did) {
        try {
          await wsService.sendToAdminDevice(did, { type: "force_logout" });
        } catch (_) {}
      }
    }

    await AdminSession.deleteMany({});

    try {
      wsService.broadcastAdminEvent("admin_session:logout_all", {});
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    logger.error("logout-all failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   LOGOUT ALL (POST version for Android)
   ═══════════════════════════════════════════ */

router.post("/sessions/logout-all", async (_req, res) => {
  try {
    const sessions = await AdminSession.find().lean();

    for (const s of sessions) {
      const did = clean((s as any).deviceId);
      if (did) {
        try {
          await wsService.sendToAdminDevice(did, { type: "force_logout" });
        } catch (_) {}
      }
    }

    await AdminSession.deleteMany({});

    try {
      wsService.broadcastAdminEvent("admin_session:logout_all", {});
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    logger.error("logout-all (post) failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════
   LOGOUT SINGLE (POST version for Android)
   ═══════════════════════════════════════════ */

router.post("/sessions/:deviceId/logout", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    await AdminSession.deleteMany({ deviceId });

    try {
      await wsService.sendToAdminDevice(deviceId, { type: "force_logout" });
      logger.info(`Sent force_logout to device ${deviceId}`);
    } catch (wsErr) {
      logger.error("force_logout ws failed", wsErr);
    }

    try {
      wsService.broadcastAdminEvent("admin_session:deleted", { deviceId });
    } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    logger.error("logout single (post) failed", e);
    return res.status(500).json({ success: false });
  }
});

export default router;
