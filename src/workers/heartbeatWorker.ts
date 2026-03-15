/**
 * heartbeatWorker.ts
 *
 * POST-MIGRATION:
 * ─────────────────────────────────────────────────────────────
 * Old behavior (REMOVED):
 *   - Checked every 10s for stale devices
 *   - Marked devices OFFLINE if no WS heartbeat in 45s
 *   - Updated status.online in DB
 *   - Notified admin panel of online→offline transitions
 *
 * New behavior:
 *   - Device reachability is determined ONLY by lastSeen.at
 *   - Panel computes "Responsive / Idle / Unreachable" from lastSeen.at
 *   - No DB writes needed — lastSeen is written by the app itself
 *   - This worker only runs periodic monitoring/logging for ops visibility
 *   - Optionally notifies admin panel when a device transitions to "Unreachable"
 *     (2+ hours since last seen) so panel can update in real-time without polling
 * ─────────────────────────────────────────────────────────────
 */

import logger from "../logger/logger";
import Device from "../models/Device";
import wsService from "../services/wsService";

// Check every 5 minutes (not 10s like before — no urgency since no DB writes)
const INTERVAL_MS = 5 * 60 * 1000;

// Thresholds matching panel display
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;        // 15 minutes
const UNREACHABLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

let timer: NodeJS.Timeout | null = null;

export function start() {
  if (timer) {
    logger.warn("heartbeatWorker: already running");
    return;
  }

  timer = setInterval(() => {
    run().catch((err) => logger.error("heartbeatWorker error", err));
  }, INTERVAL_MS);

  // Run once on start (delayed 30s to let devices connect first)
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
  logger.info("heartbeatWorker: stopped");
}

async function run() {
  try {
    const now = Date.now();

    // Find devices that were recently responsive but have gone silent
    // (lastSeen.at > 0 means device has reported at least once)
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
      } else if (diffMs <= UNREACHABLE_THRESHOLD_MS) {
        idle++;
      } else {
        unreachable++;

        // Notify admin panel that this device is now unreachable
        // (only meaningful for devices that were recently active)
        try {
          wsService.notifyDeviceLastSeen(deviceId, {
            at: lastSeenAt,
            action: (device as any).lastSeen?.action || "",
            battery: (device as any).lastSeen?.battery ?? -1,
          });
        } catch {
          // ignore — admin panel might not be connected
        }
      }
    }

    logger.info("heartbeatWorker: device status summary", {
      total: devices.length,
      responsive,
      idle,
      unreachable,
      noFcmToken,
    });

    // Warn if too many devices have no FCM token (indicates registration issue)
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