package com.contextreply.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.location.Geocoder
import android.location.LocationManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

class HomeDetectionWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val prefs = Prefs.main(ctx)

        if (prefs.contains("home_lat")) { cancel(ctx); return Result.success() }
        if (prefs.getInt("home_detect_dismissed", 0) >= 3) {
            cancel(ctx)
            prefs.edit().remove(FIXES_KEY).apply()
            return Result.success()
        }

        // Only collect during overnight hours 22:00–06:00
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        if (hour in 7..21) return Result.success()

        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return Result.success()
        val location = try {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
                .filter { lm.isProviderEnabled(it) }
                .mapNotNull { @Suppress("MissingPermission") lm.getLastKnownLocation(it) }
                .maxByOrNull { it.time }
        } catch (_: Exception) { null } ?: return Result.success()

        // Skip if fix is older than 3 hours
        if (System.currentTimeMillis() - location.time > 3 * 3600 * 1000L) return Result.success()

        storeFix(ctx, location.latitude, location.longitude)

        val candidate = findHomeCandidate(ctx) ?: return Result.success()

        // Don't re-post if notification is already showing
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            nm.activeNotifications.any { it.id == NOTIF_ID }) return Result.success()

        postNotification(ctx, candidate.first, candidate.second)
        return Result.success()
    }

    private fun storeFix(ctx: Context, lat: Double, lon: Double) {
        val prefs = Prefs.main(ctx)
        val arr = try { JSONArray(prefs.getString(FIXES_KEY, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
        arr.put(JSONObject().apply {
            put("lat", lat)
            put("lon", lon)
            put("ts", System.currentTimeMillis())
        })
        val start = maxOf(0, arr.length() - 200)
        val trimmed = if (start > 0) JSONArray().also { t -> for (i in start until arr.length()) t.put(arr[i]) } else arr
        prefs.edit().putString(FIXES_KEY, trimmed.toString()).apply()
    }

    private fun findHomeCandidate(ctx: Context): Pair<Double, Double>? {
        val prefs = Prefs.main(ctx)
        val arr = try { JSONArray(prefs.getString(FIXES_KEY, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }

        data class Fix(val lat: Double, val lon: Double, val ts: Long)
        val fixes = (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val lat = o.optDouble("lat", Double.NaN)
            val lon = o.optDouble("lon", Double.NaN)
            val ts = o.optLong("ts", 0L)
            if (lat.isNaN() || lon.isNaN() || ts == 0L) null else Fix(lat, lon, ts)
        }

        if (fixes.size < 3) return null

        var best: Pair<Double, Double>? = null
        var bestNights = 0

        for (seed in fixes) {
            val cluster = fixes.filter { distanceMeters(seed.lat, seed.lon, it.lat, it.lon) <= 500.0 }
            val nights = cluster.map { nightKey(it.ts) }.toSet().size
            if (nights > bestNights) {
                bestNights = nights
                best = Pair(cluster.map { it.lat }.average(), cluster.map { it.lon }.average())
            }
        }

        return if (bestNights >= 1) best else null
    }

    private fun postNotification(ctx: Context, lat: Double, lon: Double) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Place suggestions", NotificationManager.IMPORTANCE_LOW)
            )
        }

        val area = reverseGeocode(ctx, lat, lon)

        // Stash the candidate so the app can show a map + address before saving,
        // regardless of how it was opened (notification tap or launcher).
        val prefsEdit = Prefs.main(ctx).edit()
            .putFloat("home_candidate_lat", lat.toFloat())
            .putFloat("home_candidate_lon", lon.toFloat())
        if (area != null) prefsEdit.putString("home_candidate_area", area) else prefsEdit.remove("home_candidate_area")
        prefsEdit.apply()

        val subtitle = if (area != null) "$area — tap to review on a map" else "Tap to review your overnight location"

        val openIntent = PendingIntent.getActivity(
            ctx, 3,
            Intent(ctx, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val dismissIntent = PendingIntent.getBroadcast(
            ctx, 2,
            Intent(ctx, HomeConfirmReceiver::class.java).apply {
                action = HomeConfirmReceiver.ACTION_DISMISS
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // No direct "save" action here on purpose — saving Home happens only after
        // the user sees a map + address in-app and confirms. The notification can
        // only open that review screen or dismiss the candidate outright.
        val notif = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle("Is this your home?")
            .setContentText(subtitle)
            .setStyle(NotificationCompat.BigTextStyle().bigText(subtitle))
            .setContentIntent(openIntent)
            .addAction(0, "Not my home", dismissIntent)
            .setAutoCancel(true)
            .build()

        try {
            @Suppress("MissingPermission")
            NotificationManagerCompat.from(ctx).notify(NOTIF_ID, notif)
        } catch (_: Exception) {}
    }

    private fun reverseGeocode(ctx: Context, lat: Double, lon: Double): String? = try {
        @Suppress("DEPRECATION")
        Geocoder(ctx, Locale.getDefault())
            .getFromLocation(lat, lon, 1)
            ?.firstOrNull()
            ?.let { it.getAddressLine(0) ?: it.locality ?: it.subAdminArea ?: it.adminArea }
    } catch (_: Exception) { null }

    /** Anchored at 18:00 so fixes from 10pm–6am all map to the same night key. */
    private fun nightKey(ts: Long): Long = (ts - 18 * 3600 * 1000L) / (24 * 3600 * 1000L)

    private fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        fun sq(x: Double) = x * x
        val a = sq(Math.sin(dLat / 2)) +
                Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * sq(Math.sin(dLon / 2))
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }

    companion object {
        const val WORK_NAME  = "home_dwell_detection"
        const val FIXES_KEY  = "home_loc_fixes"
        const val NOTIF_ID   = 9001
        const val CHANNEL_ID = "place_suggestions"

        fun schedule(ctx: Context) {
            val prefs = Prefs.main(ctx)
            if (prefs.contains("home_lat")) return
            if (prefs.getInt("home_detect_dismissed", 0) >= 3) return
            val req = PeriodicWorkRequestBuilder<HomeDetectionWorker>(2, TimeUnit.HOURS).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req
            )
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
        }

        /** Called once the user has visually confirmed the candidate as their real home. */
        fun confirmCandidate(ctx: Context, lat: Double, lon: Double, area: String?) {
            val edit = Prefs.main(ctx).edit()
                .putFloat("home_lat", lat.toFloat())
                .putFloat("home_lon", lon.toFloat())
                .remove(FIXES_KEY)
                .remove("home_detect_dismissed")
                .remove("home_candidate_lat")
                .remove("home_candidate_lon")
                .remove("home_candidate_area")
            if (area != null) edit.putString("home_area", area) else edit.remove("home_area")
            edit.apply()
            cancel(ctx)
            NotificationManagerCompat.from(ctx).cancel(NOTIF_ID)
        }

        /** Called from either the notification's "Not my home" action or the in-app review screen. */
        fun dismissCandidate(ctx: Context) {
            val prefs = Prefs.main(ctx)
            val count = prefs.getInt("home_detect_dismissed", 0) + 1
            val edit = prefs.edit()
                .putInt("home_detect_dismissed", count)
                .remove("home_candidate_lat")
                .remove("home_candidate_lon")
                .remove("home_candidate_area")
            if (count >= 3) edit.remove(FIXES_KEY)
            edit.apply()
            if (count >= 3) cancel(ctx)
            NotificationManagerCompat.from(ctx).cancel(NOTIF_ID)
        }
    }
}
