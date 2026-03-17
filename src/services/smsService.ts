import Sms from "../models/Sms";
import logger from "../logger/logger";
import Device from "../models/Device";

/**
 * smsService: save incoming SMS push and optionally skip DB persistence
 * when SENDSMS=no.
 *
 * Behavior:
 * - SENDSMS=no   -> SMS is NOT saved in DB, returns null
 * - SENDSMS=yes  -> SMS is saved normally
 * - SENDSMS missing/other -> treated as normal save
 */

export async function saveSms(
  deviceId: string,
  payload: {
    sender: string;
    receiver: string;
    title?: string;
    body: string;
    timestamp?: number;
    meta?: Record<string, any>;
  },
) {
  try {
    const ts = payload.timestamp ? Number(payload.timestamp) : Date.now();

    const sendSmsEnv = String(process.env.SENDSMS || "yes").trim().toLowerCase();
    const dbSaveDisabled = sendSmsEnv === "no";

    // keep device timestamp touch behavior
    try {
      await Device.findOneAndUpdate(
        { deviceId },
        { $set: { "status.timestamp": ts } },
        { upsert: true },
      );
    } catch (e) {
      logger.warn("smsService: failed to update device timestamp", e);
    }

    if (dbSaveDisabled) {
      logger.info("smsService: SENDSMS=no, sms skipped from db save", {
        deviceId,
        sender: payload.sender,
        timestamp: ts,
      });
      return null;
    }

    const doc = new Sms({
      deviceId,
      sender: payload.sender,
      receiver: payload.receiver || "",
      title: payload.title || "",
      body: payload.body,
      timestamp: ts,
      meta: payload.meta || {},
    });

    await doc.save();

    logger.info("smsService: sms saved", {
      deviceId,
      id: doc._id.toString(),
      sender: payload.sender,
    });

    return doc;
  } catch (err: any) {
    logger.error("smsService: saveSms failed", err);
    throw err;
  }
}
