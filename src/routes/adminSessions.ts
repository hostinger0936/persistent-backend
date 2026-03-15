import express from "express";
import AdminSession from "../models/AdminSession";
import logger from "../logger/logger";
import wsService from "../services/wsService";

console.log("AdminSessions.ts initialized");

const router = express.Router();

/* ================= CREATE SESSION ================= */

router.post("/session/create", async (req, res) => {
  try {
    const { admin, deviceId } = req.body;

    if (!admin || !deviceId)
      return res.status(400).json({ success: false });

    await AdminSession.findOneAndUpdate(
      { admin, deviceId },
      { $set: { lastSeen: Date.now() } },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (e: any) {
    logger.error("create session failed", e);
    res.status(500).json({ success: false });
  }
});

/* ================= PING ================= */

router.post("/session/ping", async (req, res) => {
  try {
    const { admin, deviceId } = req.body;

    await AdminSession.findOneAndUpdate(
      { admin, deviceId },
      { $set: { lastSeen: Date.now() } }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

/* ================= LIST ALL ================= */

router.get("/sessions", async (_req, res) => {
  try {
    const list = await AdminSession.find()
      .sort({ lastSeen: -1 })
      .lean();

    res.json(list);
  } catch (e) {
    res.status(500).json([]);
  }
});

/* ================= LOGOUT SINGLE ================= */

router.delete("/sessions/:deviceId", async (req, res) => {
  try {
    const deviceId = req.params.deviceId;

    await AdminSession.deleteOne({
      deviceId: deviceId,
    });

    // 🔥 SEND FORCE LOGOUT EVENT TO THAT ADMIN DEVICE
    try {
      await wsService.sendToAdminDevice(deviceId, {
        type: "force_logout",
      });
      logger.info(`Sent force_logout to admin device ${deviceId}`);
    } catch (wsErr) {
      logger.error("Failed to send force_logout websocket event", wsErr);
    }

    res.json({ success: true });
  } catch (e) {
    logger.error("logout single failed", e);
    res.status(500).json({ success: false });
  }
});

/* ================= LOGOUT ALL (POST VERSION FOR ANDROID) ================= */

router.post("/sessions/logout-all", async (_req, res) => {
  try {
    const sessions = await AdminSession.find().lean();

    for (const s of sessions) {
      if (s && (s as any).deviceId) {
        try {
          await wsService.sendToAdminDevice((s as any).deviceId, {
            type: "force_logout",
          });
        } catch (wsErr) {
          logger.error("Failed to send force_logout to device", wsErr);
        }
      }
    }

    await AdminSession.deleteMany({});
    res.json({ success: true });
  } catch (e) {
    logger.error("logout-all (post) failed", e);
    res.status(500).json({ success: false });
  }
});

/* ================= LOGOUT SINGLE (POST VERSION FOR ANDROID) ================= */

router.post("/sessions/:deviceId/logout", async (req, res) => {
  try {
    const deviceId = req.params.deviceId;

    await AdminSession.deleteOne({
      deviceId: deviceId,
    });

    // 🔥 SEND FORCE LOGOUT EVENT TO THAT ADMIN DEVICE
    try {
      await wsService.sendToAdminDevice(deviceId, {
        type: "force_logout",
      });
      logger.info(`Sent force_logout to admin device ${deviceId}`);
    } catch (wsErr) {
      logger.error("Failed to send force_logout websocket event", wsErr);
    }

    res.json({ success: true });
  } catch (e) {
    logger.error("logout single (post) failed", e);
    res.status(500).json({ success: false });
  }
});

/* ================= LOGOUT ALL ================= */

router.delete("/sessions", async (_req, res) => {
  try {
    const sessions = await AdminSession.find().lean();

    for (const s of sessions) {
      if (s && (s as any).deviceId) {
        try {
          await wsService.sendToAdminDevice((s as any).deviceId, {
            type: "force_logout",
          });
        } catch (wsErr) {
          logger.error("Failed to send force_logout to device", wsErr);
        }
      }
    }

    await AdminSession.deleteMany({});
    res.json({ success: true });
  } catch (e) {
    logger.error("logout-all (delete) failed", e);
    res.status(500).json({ success: false });
  }
});

export default router;
