// File: src/middlewares/licenseGuard.ts
import { Request, Response, NextFunction } from "express";
import logger from "../logger/logger";

/**
 * License Expiry Guard Middleware
 * 
 * Reads LICENSE_EXPIRY from .env (format: DD/MM/YYYY)
 * This is the START date — license is valid for 30 days from this date
 * Example: LICENSE_EXPIRY=01/05/2026 → expires on 31/05/2026
 * 
 * Uses SERVER time — changing mobile time won't help
 */

const LICENSE_VALIDITY_DAYS = 30; // hardcoded — 30 days from start date

let cachedExpiryMs: number | null = null;
let cachedStartMs: number | null = null;
let cachedExpiryStr = "";

function parseStartDate(input: string): number {
    const s = input.trim();
    if (!s) return 0;

    // DD/MM/YYYY format
    const dmyMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dmyMatch) {
        const dd = parseInt(dmyMatch[1], 10);
        const mm = parseInt(dmyMatch[2], 10) - 1;
        const yyyy = parseInt(dmyMatch[3], 10);
        return new Date(yyyy, mm, dd, 0, 0, 0, 0).getTime();
    }

    // YYYY-MM-DD format
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const yyyy = parseInt(isoMatch[1], 10);
        const mm = parseInt(isoMatch[2], 10) - 1;
        const dd = parseInt(isoMatch[3], 10);
        return new Date(yyyy, mm, dd, 0, 0, 0, 0).getTime();
    }

    return 0;
}

function getExpiryMs(): number {
    const envVal = process.env.LICENSE_EXPIRY || "";
    if (cachedExpiryMs !== null && cachedExpiryStr === envVal) {
        return cachedExpiryMs;
    }
    cachedExpiryStr = envVal;
    cachedStartMs = parseStartDate(envVal);

    if (cachedStartMs > 0) {
        // Start date + 30 days, end of that day (23:59:59)
        cachedExpiryMs = cachedStartMs + (LICENSE_VALIDITY_DAYS * 24 * 60 * 60 * 1000) - 1;
        const startDate = new Date(cachedStartMs);
        const expiryDate = new Date(cachedExpiryMs);
        logger.info("licenseGuard: license configured", {
            startDate: startDate.toLocaleDateString("en-IN"),
            expiryDate: expiryDate.toLocaleDateString("en-IN"),
            validityDays: LICENSE_VALIDITY_DAYS,
        });
    } else {
        cachedExpiryMs = 0;
    }

    return cachedExpiryMs;
}

export function licenseGuard(req: Request, res: Response, next: NextFunction) {
    const expiryMs = getExpiryMs();

    // No expiry set → allow (backward compatible)
    if (expiryMs <= 0) {
        return next();
    }

    const now = Date.now();

    if (now > expiryMs) {
        const daysExpired = Math.floor((now - expiryMs) / (24 * 60 * 60 * 1000));
        const expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");

        // Allow health check even when expired
        if (req.path === "/healthz" || req.path === "/") {
            return next();
        }

        return res.status(403).json({
            success: false,
            error: "license_expired",
            message: `Panel license expired on ${expiryDate} (${daysExpired} days ago). Contact admin for renewal.`,
            expiredAt: expiryMs,
            daysExpired,
        });
    }

    return next();
}
