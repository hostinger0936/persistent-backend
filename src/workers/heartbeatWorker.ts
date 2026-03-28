import logger from "../logger/logger";
import Device from "../models/Device";
import wsService from "../services/wsService";
import { sendPing } from "../services/fcmService";

const INTERVAL_MS = 5 * 60 * 1000;

const IDLE_THRESHOLD_MS = 15 * 60 * 1000;
const UNREACHABLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

// ──── NEW: ping config ────
const PING_AFTER_IDLE_MS = 30 * 60 * 1000;   // ping when idle for 30+ min
const PING_COOLDOWN_MS = 60 * 60 * 1000;     // don't re-ping same device within 1 hour
const lastPingedMap = new Map<string, number>(); // in-memory only, no DB writes
// ──── END NEW ────

let timer: NodeJS.Timeout | null = null;

export function start() {
  if (timer) {
    logger.warn("heartbeatWorker: already running");
    return;
  }

  timer = setInterval(() => {
    run().catch((err) => logger.error("heartbeatWorker error", err));
  }, INTERVAL_MS);

  setTimeout(() => {
    run().catch((err) => logger.error("heartbeatWorker initial run failed", err));
  }, 30_000);

  logger.info("heartbeatWorker: started", { intervalMs: INTERVAL_MS });
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastPingedMap.clear();
  logger.info("heartbeatWorker: stopped");
}

async function run() {
  try {
    const now = Date.now();

    const devices = await Device.find({
      "lastSeen.at": { $gt: 0 },
    })
      .select("deviceId lastSeen metadata.model metadata.brand fcmToken")
      .lean();

    if (!devices || devices.length === 0) {
      logger.debug("heartbeatWorker: no devices with lastSeen data");
      return;
    }

    let responsive = 0;
    let idle = 0;
    let unreachable = 0;
    let noFcmToken = 0;
    let pinged = 0;
    let pingSkippedCooldown = 0;

    for (const device of devices) {
      const deviceId = String((device as any).deviceId || "").trim();
      if (!deviceId) continue;

      const lastSeenAt = Number((device as any).lastSeen?.at || 0);
      const diffMs = now - lastSeenAt;
      const hasFcmToken = !!String((device as any).fcmToken || "").trim();

      if (!hasFcmToken) {
        noFcmToken++;
      }

      if (diffMs <= IDLE_THRESHOLD_MS) {
        responsive++;

        // ──── NEW: device came back, clear ping tracking ────
        if (lastPingedMap.has(deviceId)) {
          lastPingedMap.delete(deviceId);
        }
        // ──── END NEW ────

      } else if (diffMs <= UNREACHABLE_THRESHOLD_MS) {
        idle++;

        // ──── NEW: ping idle device (once, with cooldown) ────
        if (hasFcmToken && diffMs >= PING_AFTER_IDLE_MS) {
          const lastPinged = lastPingedMap.get(deviceId) || 0;
          const sincePing = now - lastPinged;

          if (sincePing >= PING_COOLDOWN_MS) {
            try {
              await sendPing(deviceId);
              lastPingedMap.set(deviceId, now);
              pinged++;
              logger.info("heartbeatWorker: pinged idle device", {
                deviceId,
                idleForMin: Math.round(diffMs / 60000),
              });
            } catch (pingErr) {
              logger.warn("heartbeatWorker: ping failed", {
                deviceId,
                error: (pingErr as any)?.message || pingErr,
              });
            }
          } else {
            pingSkippedCooldown++;
          }
        }
        // ──── END NEW ────

      } else {
        unreachable++;

        // ──── NEW: cleanup — no point tracking unreachable devices ────
        if (lastPingedMap.has(deviceId)) {
          lastPingedMap.delete(deviceId);
        }
        // ──── END NEW ────

        try {
          wsService.notifyDeviceLastSeen(deviceId, {
            at: lastSeenAt,
            action: (device as any).lastSeen?.action || "",
            battery: (device as any).lastSeen?.battery ?? -1,
          });
        } catch {
          // ignore
        }
      }
    }

    logger.info("heartbeatWorker: device status summary", {
      total: devices.length,
      responsive,
      idle,
      unreachable,
      noFcmToken,
      pinged,
      pingSkippedCooldown,
    });

    if (noFcmToken > 0 && devices.length > 0) {
      const pct = Math.round((noFcmToken / devices.length) * 100);
      if (pct > 20) {
        logger.warn("heartbeatWorker: high % of devices without FCM token", {
          noFcmToken,
          total: devices.length,
          percent: pct,
        });
      }
    }
  } catch (err) {
    logger.error("heartbeatWorker: run error", err);
  }
}
