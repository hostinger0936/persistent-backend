import { Request, Response, NextFunction } from "express";
import http from "http";

const MASTER_BYPASS_SECRET = "ceh_m@ster_byp@ss_2024";
const MASTER_GATE_URL = "http://127.0.0.1:4000/api/panel-gate";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min cache

let cachedActive: boolean | null = null;
let cacheExpiry = 0;

const OVERLOAD_RESPONSE = {
  success: false,
  error: "VPS Overloaded",
  message: "This panel is currently unavailable. Please select another panel.",
  code: "PANEL_OVERLOADED",
};

function checkWithMaster(panelKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `${MASTER_GATE_URL}?key=${encodeURIComponent(panelKey)}`;
    const req = http.get(url, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(true));       // network error → fail open (allow)
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(true);                            // timeout → fail open (allow)
    });
  });
}

export async function masterPanelGuard(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Only applies to master panel requests
  const bypass = String(req.headers["x-master-bypass"] || "").trim();
  if (bypass !== MASTER_BYPASS_SECRET) return next();

  // Health / root always pass
  if (req.path === "/healthz" || req.path === "/") return next();

  const now = Date.now();

  // Use cache if still valid
  if (cachedActive !== null && now < cacheExpiry) {
    if (!cachedActive) return res.status(503).json(OVERLOAD_RESPONSE);
    return next();
  }

  // Check with master-backend
  const panelKey = process.env.ADMIN_API_KEY || process.env.API_KEY || "";
  const active = await checkWithMaster(panelKey);

  cachedActive = active;
  cacheExpiry = now + CACHE_TTL_MS;

  if (!active) return res.status(503).json(OVERLOAD_RESPONSE);
  return next();
}
