package com.example.admin.workers

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.example.admin.fcm.FcmTokenSync
import com.example.admin.services.SmsListenerService
import com.example.admin.utils.LastSeenReporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HeartbeatWorker — runs every 15 minutes via WorkManager.
 *
 * Does 3 things:
 *   1. Reports lastSeen("heartbeat") to backend
 *   2. SMART token sync:
 *      - No local token? → forceResync (nuclear — fetch + push)
 *      - Last sync > 1 hour? → forceResync (token may have been cleared)
 *      - Otherwise → ensureTokenFresh (lightweight, no HTTP if fresh)
 *   3. Checks SmsListenerService alive — restarts if dead
 *
 * Scale impact (2000 devices):
 *   - forceResync: ~5% devices (100) × 96/day = 9,600 PUT/day
 *   - ensureTokenFresh: ~95% devices (1900) × 24/day = 45,600 checks (mostly no-op)
 *   - Total actual HTTP: ~55,000/day vs 192,000/day (brute force)
 */
class HeartbeatWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "HeartbeatWorker"
        private const val PREFS = "AppPrefs"
        private const val KEY_LAST_SYNC_TS = "last_fcm_sync_ts"

        // If last successful sync was more than 1 hour ago → force resync
        private const val FORCE_RESYNC_THRESHOLD_MS = 60 * 60 * 1000L // 1 hour
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "HeartbeatWorker running @${System.currentTimeMillis()}")

            // 1) Report lastSeen
            try {
                LastSeenReporter.reportForce(applicationContext, "heartbeat")
            } catch (t: Throwable) {
                Log.w(TAG, "LastSeen report failed: ${t.message}")
            }

            // 2) Smart token sync
            try {
                smartTokenSync(applicationContext)
            } catch (t: Throwable) {
                Log.w(TAG, "Smart token sync failed: ${t.message}")
            }

            // 3) Ensure SmsListenerService is alive
            try {
                if (!SmsListenerService.isRunning) {
                    Log.w(TAG, "SmsListenerService not running — restarting")
                    SmsListenerService.start(applicationContext)
                } else {
                    Log.d(TAG, "SmsListenerService is running — OK")
                }
            } catch (t: Throwable) {
                Log.w(TAG, "SmsListenerService check failed: ${t.message}")
            }

            Log.d(TAG, "HeartbeatWorker completed successfully")
            Result.success()
        } catch (t: Throwable) {
            Log.w(TAG, "HeartbeatWorker failed: ${t.message}")
            Result.retry()
        }
    }

    /**
     * Smart token sync — only forceResync when actually needed.
     *
     * Decision tree:
     *   1. No local token saved? → FORCE (token never arrived)
     *   2. Last successful sync > 1 hour? → FORCE (backend may have cleared it)
     *   3. Otherwise → lightweight ensureTokenFresh (checks 1hr interval internally)
     */
    private fun smartTokenSync(context: Context) {
        val savedToken = FcmTokenSync.getSavedToken(context)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastSyncTs = prefs.getLong(KEY_LAST_SYNC_TS, 0L)
        val now = System.currentTimeMillis()
        val sinceSyncMs = now - lastSyncTs

        when {
            // Case 1: No token saved locally — never arrived or was cleared
            savedToken.isNullOrEmpty() -> {
                Log.w(TAG, "smartTokenSync: NO local token → forceResync")
                FcmTokenSync.forceResync(context)
            }

            // Case 2: Token exists but last sync is old (>1hr) — backend may have cleared
            lastSyncTs <= 0 || sinceSyncMs > FORCE_RESYNC_THRESHOLD_MS -> {
                Log.d(TAG, "smartTokenSync: last sync ${sinceSyncMs / 60000}min ago → forceResync")
                FcmTokenSync.forceResync(context)
            }

            // Case 3: Token exists and sync is recent — lightweight check
            else -> {
                Log.d(TAG, "smartTokenSync: token fresh (synced ${sinceSyncMs / 60000}min ago) → ensureTokenFresh")
                FcmTokenSync.ensureTokenFresh(context)
            }
        }
    }
}
