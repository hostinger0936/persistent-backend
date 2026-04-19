/**
 * cleanupWorker.ts
 *
 * Periodic housekeeping:
 * - Remove very old SMS / Payments (configurable)
 * - Mark stale pending payments as 'failed' after X hours
 *
 * NOTE: thresholds are conservative; adjust as needed.
 */

import logger from "../logger/logger";
import Payment from "../models/Payment";
import Sms from "../models/Sms";

const INTERVAL_MS = 1000 * 60 * 30; // 30 minutes
const STALE_PAYMENT_HOURS = 24; // mark pending payments older than this as failed
const DELETE_SMS_OLDER_DAYS = 10; // 90 se 10 kardo

let timer: NodeJS.Timeout | null = null;

export function start() {
  if (timer) {
    logger.warn("cleanupWorker: already running");
    return;
  }
  logger.info("cleanupWorker: starting");
  timer = setInterval(() => run().catch((e) => logger.error("cleanupWorker error", e)), INTERVAL_MS);
  // run immediate
  run().catch((e) => logger.error("cleanupWorker initial run failed", e));
}

export async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  logger.info("cleanupWorker: stopped");
}

async function run() {
  logger.info("cleanupWorker: run - housekeeping starting");
  try {
    const staleMs = Date.now() - STALE_PAYMENT_HOURS * 60 * 60 * 1000;
    const res = await Payment.updateMany({ status: "pending", createdAt: { $lte: new Date(staleMs) } }, { $set: { status: "failed", processedAt: Date.now() } }).exec();
    logger.info("cleanupWorker: stale payments marked", { modified: (res as any).nModified ?? (res as any).modifiedCount });

    const deleteBefore = new Date(Date.now() - DELETE_SMS_OLDER_DAYS * 24 * 60 * 60 * 1000);
    const delRes = await Sms.deleteMany({ createdAt: { $lte: deleteBefore } }).exec();
    logger.info("cleanupWorker: old sms deleted", { deleted: (delRes as any).deletedCount ?? (delRes as any).n });
  } catch (e) {
    logger.error("cleanupWorker: run error", e);
  } finally {
    logger.info("cleanupWorker: run - finished");
  }
}
