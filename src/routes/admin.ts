import express, { Request, Response } from "express";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";

const router = express.Router();

/**
 * =====================================
 * INTERNAL HELPERS
 * =====================================
 */

const DELETE_PASSWORD_KEY = "delete_password";
const DELETE_PASSWORD_PHONE = "delete_password";

function clean(v: any): string {
  return String(v ?? "").trim();
}

function getDeletePasswordPaths(path: string): string[] {
  // keep backward compatibility + support /api/admin/... paths
  return [path, `/admin${path}`];
}

async function getDeletePasswordDoc() {
  return AdminModel.findOne({ key: DELETE_PASSWORD_KEY }).lean();
}

async function getStoredDeletePassword(): Promise<string> {
  const doc = await getDeletePasswordDoc();
  return clean((doc as any)?.meta?.password || "");
}

async function isDeletePasswordSet(): Promise<boolean> {
  const pwd = await getStoredDeletePassword();
  return pwd.length >= 4;
}

async function saveDeletePassword(password: string) {
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
}

async function verifyOrCreateDeletePassword(password: string): Promise<{
  success: boolean;
  verified: boolean;
  created: boolean;
  error?: string;
}> {
  const cleanPassword = clean(password);

  if (!cleanPassword) {
    return {
      success: false,
      verified: false,
      created: false,
      error: "password required",
    };
  }

  if (cleanPassword.length < 4) {
    return {
      success: false,
      verified: false,
      created: false,
      error: "password must be at least 4 digits",
    };
  }

  const stored = await getStoredDeletePassword();

  // first-time set
  if (!stored) {
    await saveDeletePassword(cleanPassword);

    logger.info("admin: delete password created");

    return {
      success: true,
      verified: true,
      created: true,
    };
  }

  // verify existing
  if (stored !== cleanPassword) {
    return {
      success: false,
      verified: false,
      created: false,
      error: "invalid password",
    };
  }

  return {
    success: true,
    verified: true,
    created: false,
  };
}

async function changeDeletePassword(currentPassword: string, newPassword: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const current = clean(currentPassword);
  const next = clean(newPassword);

  const stored = await getStoredDeletePassword();

  if (!stored) {
    return {
      success: false,
      error: "password not set",
    };
  }

  if (!current) {
    return {
      success: false,
      error: "current password required",
    };
  }

  if (stored !== current) {
    return {
      success: false,
      error: "invalid current password",
    };
  }

  if (!next) {
    return {
      success: false,
      error: "new password required",
    };
  }

  if (next.length < 4) {
    return {
      success: false,
      error: "new password must be at least 4 digits",
    };
  }

  await saveDeletePassword(next);

  logger.info("admin: delete password changed");

  return { success: true };
}

/**
 * =====================================
 * ADMIN LOGIN ROUTES
 * =====================================
 */

/**
 * GET /admin/login
 * Returns stored admin credentials
 */
router.get(["/login", "/admin/login"], async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "login" }).lean();

    if (!doc) {
      return res.json({
        username: "",
        password: "",
      });
    }

    return res.json({
      username: (doc as any)?.meta?.username || "",
      password: (doc as any)?.meta?.password || "",
    });
  } catch (err: any) {
    logger.error("admin: get login failed", err);
    return res.status(500).json({
      success: false,
      error: "server error",
    });
  }
});

/**
 * PUT /admin/login
 * CREATE OR UPDATE admin credentials
 */
router.put(["/login", "/admin/login"], async (req: Request, res: Response) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "missing username or password",
    });
  }

  try {
    await AdminModel.findOneAndUpdate(
      { key: "login" },
      {
        $set: {
          phone: "login", // required field
          meta: { username, password },
        },
      },
      { upsert: true, new: true },
    );

    logger.info("admin: login updated", { username });

    return res.json({
      success: true,
      message: "admin credentials saved",
    });
  } catch (err: any) {
    logger.error("admin: login update failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/**
 * =====================================
 * GLOBAL PHONE ROUTES
 * =====================================
 */

/**
 * GET /admin/globalPhone
 */
router.get(["/globalPhone", "/admin/globalPhone"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();

    return res.json({
      phone: (doc as any)?.phone || "",
    });
  } catch (err) {
    logger.error("admin: get globalPhone failed", err);
    return res.status(500).json({
      phone: "",
    });
  }
});

/**
 * PUT /admin/globalPhone
 * Supports BOTH update & erase
 */
router.put(["/globalPhone", "/admin/globalPhone"], async (req: Request, res: Response) => {
  const phone = req.body?.phone;

  // reject only if field missing entirely
  if (phone === undefined) {
    return res.status(400).json({
      success: false,
      error: "phone field required",
    });
  }

  try {
    await AdminModel.findOneAndUpdate(
      { key: "global" },
      { $set: { phone: phone || "" } },
      { upsert: true, new: true },
    );

    logger.info("admin: globalPhone updated", { phone });

    // OPTIONAL: broadcast update to admin WS
    try {
      const wsService = require("../services/wsService").default;

      if (wsService?.sendToAdminDevice) {
        wsService.sendToAdminDevice("__ADMIN__", {
          type: "event",
          event: "global_phone_updated",
          phone: phone || "",
        });
      }
    } catch (_) {
      // ignore ws errors
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("admin: update globalPhone failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/**
 * =====================================
 * DELETE PASSWORD ROUTES
 * =====================================
 */

/**
 * GET /admin/deletePassword/status
 * Returns whether delete password is set
 */
router.get(
  getDeletePasswordPaths("/deletePassword/status"),
  async (_req: Request, res: Response) => {
    try {
      const isSet = await isDeletePasswordSet();

      return res.json({
        success: true,
        isSet,
      });
    } catch (err: any) {
      logger.error("admin: deletePassword status failed", err);
      return res.status(500).json({
        success: false,
        error: "server error",
      });
    }
  },
);

/**
 * POST /admin/deletePassword/verify
 * - if password not set => create it
 * - if password exists => verify it
 */
router.post(
  getDeletePasswordPaths("/deletePassword/verify"),
  async (req: Request, res: Response) => {
    const password = clean(req.body?.password);

    try {
      const result = await verifyOrCreateDeletePassword(password);

      if (!result.success) {
        const status =
          result.error === "password required" || result.error === "password must be at least 4 digits"
            ? 400
            : 403;

        return res.status(status).json(result);
      }

      return res.json(result);
    } catch (err: any) {
      logger.error("admin: deletePassword verify failed", err);
      return res.status(500).json({
        success: false,
        verified: false,
        created: false,
        error: "server error",
      });
    }
  },
);

/**
 * POST /admin/deletePassword/change
 * Requires currentPassword and newPassword
 */
router.post(
  getDeletePasswordPaths("/deletePassword/change"),
  async (req: Request, res: Response) => {
    const currentPassword = clean(req.body?.currentPassword);
    const newPassword = clean(req.body?.newPassword);

    try {
      const result = await changeDeletePassword(currentPassword, newPassword);

      if (!result.success) {
        const status =
          result.error === "password not set" ||
          result.error === "current password required" ||
          result.error === "new password required" ||
          result.error === "new password must be at least 4 digits"
            ? 400
            : 403;

        return res.status(status).json(result);
      }

      return res.json({
        success: true,
        message: "password changed",
      });
    } catch (err: any) {
      logger.error("admin: deletePassword change failed", err);
      return res.status(500).json({
        success: false,
        error: "server error",
      });
    }
  },
);

export default router;
