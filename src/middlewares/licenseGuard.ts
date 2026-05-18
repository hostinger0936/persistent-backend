// File: src/middlewares/licenseGuard.ts
import { Request, Response, NextFunction } from "express";
import logger from "../logger/logger";

/**
 * License Expiry Guard Middleware
 * 
 * Reads LICENSE_EXPIRY from .env (format: DD/MM/YYYY)
 * If expired → blocks ALL API requests with 403
 * Uses SERVER time — changing mobile time won't help
 * 
 * .env example:
 * LICENSE_EXPIRY=01/06/2026
 */

let cachedExpiryMs: number | null = null;
let cachedExpiryStr = "";

function parseExpiryDate(input: string): number {
    const s = input.trim();
    if (!s) return 0;

    // DD/MM/YYYY format
    const dmyMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dmyMatch) {
        const dd = parseInt(dmyMatch[1], 10);
        const mm = parseInt(dmyMatch[2], 10) - 1; // 0-indexed month
        const yyyy = parseInt(dmyMatch[3], 10);
        // Set to end of day (23:59:59) so it expires AFTER that day
        return new Date(yyyy, mm, dd, 23, 59, 59, 999).getTime();
    }

    // YYYY-MM-DD format
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const yyyy = parseInt(isoMatch[1], 10);
        const mm = parseInt(isoMatch[2], 10) - 1;
        const dd = parseInt(isoMatch[3], 10);
        return new Date(yyyy, mm, dd, 23, 59, 59, 999).getTime();
    }

    return 0;
}

function getExpiryMs(): number {
    const envVal = process.env.LICENSE_EXPIRY || "";
    // Cache so we don't parse every request
    if (cachedExpiryMs !== null && cachedExpiryStr === envVal) {
        return cachedExpiryMs;
    }
    cachedExpiryStr = envVal;
    cachedExpiryMs = parseExpiryDate(envVal);

    if (cachedExpiryMs > 0) {
        const expiryDate = new Date(cachedExpiryMs);
        logger.info("licenseGuard: LICENSE_EXPIRY set", {
            raw: envVal,
            expiryDate: expiryDate.toISOString(),
        });
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
        // Calculate days expired
        const daysExpired = Math.floor((now - expiryMs) / (24 * 60 * 60 * 1000));
        const expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");

        // Allow health check even when expired
        if (req.path === "/healthz" || req.path === "/") {
            return next();
        }

        // Allow device registration PUT (so devices keep sending data — just admin panel blocked)
        // Actually block everything — admin can't see, devices can't push
        
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
