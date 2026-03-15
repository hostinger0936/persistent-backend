import Sms from "../models/Sms";
import logger from "../logger/logger";
import { touchLastSeen } from "./deviceService";

/**
 * smsService: save incoming SMS push and touch device lastSeen.
 *
 * POST-MIGRATION:
 *   - Removed: Device status.timestamp update
 *   - Added: touchLastSeen() call after SMS save
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

    // Touch lastSeen — device is alive (it pushed SMS data)
    try {
      await touchLastSeen(deviceId, "sms_pushed");
    } catch (e) {
      logger.warn("smsService: touchLastSeen failed", e);
    }

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