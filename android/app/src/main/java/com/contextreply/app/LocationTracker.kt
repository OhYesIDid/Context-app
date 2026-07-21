package com.contextreply.app

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle

// Owns the app's single live-location fix, extracted from ProTxtBgService.kt (part of its
// God Class split). Almost entirely Android-framework-bound (LocationManager/Geocoder), unlike
// the previous pieces — the only genuinely pure, unit-testable logic is the two staleness
// thresholds in the companion object below; everything else is a thin, stateful wrapper that
// ProTxtBgService now delegates to instead of owning directly. Instantiated once per service
// (not an `object` like IntentAndSignals/ContactLinking, since it holds real mutable state).
class LocationTracker {

    companion object {
        // Continuous listener freshness — a fix older than this is treated as stale and
        // ignored rather than overwriting a still-recent lastLocation.
        private const val CONTINUOUS_FRESHNESS_MS = 2 * 60 * 1_000L
        // getCurrentLocation()'s "already fresh enough, skip the blocking one-shot wait" bar.
        private const val CACHED_FRESHNESS_MS = 30_000L
        private const val ONE_SHOT_WAIT_SECONDS = 5L

        // Pure, testable without a Context — mirror the exact original inline comparisons
        // (note the two use different operators, <= vs <; preserved deliberately, not unified
        // into one shared helper, since collapsing them would be a real behavior change at
        // the exact boundary even though it'd never be observable in practice).
        internal fun isContinuousFixFresh(fixTimeMs: Long, nowMs: Long = System.currentTimeMillis()): Boolean =
            nowMs - fixTimeMs <= CONTINUOUS_FRESHNESS_MS

        internal fun isCachedFixFreshEnough(fixTimeMs: Long, nowMs: Long = System.currentTimeMillis()): Boolean =
            nowMs - fixTimeMs < CACHED_FRESHNESS_MS
    }

    @Volatile private var lastLocation: Location? = null

    private val continuousListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            if (isContinuousFixFresh(loc.time)) lastLocation = loc
        }
        @Deprecated("Deprecated in Java") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
    }

    // Registers the continuous listener — call from onListenerConnected. No fallback to
    // getLastKnownLocation(); a stale cached fix is worse than no data.
    fun start(context: Context) {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).forEach { provider ->
            try {
                if (lm.isProviderEnabled(provider))
                    lm.requestLocationUpdates(provider, 15_000L, 10f, continuousListener, context.mainLooper)
            } catch (_: SecurityException) {}
        }
    }

    // Call from onListenerDisconnected / onDestroy.
    fun stop(context: Context) {
        try {
            (context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(continuousListener)
        } catch (_: Exception) {}
    }

    fun getLastLocation(): Location? = lastLocation

    // Returns the most recent live location. If lastLocation is fresh enough, use it
    // directly. Otherwise requests a one-shot update and blocks the calling thread up to
    // ONE_SHOT_WAIT_SECONDS for a new fix, falling back to lastLocation (any age) if none
    // arrives in time. Called from worker threads only — never call from the main thread.
    fun getCurrentLocation(context: Context): Location? {
        lastLocation?.let { if (isCachedFixFreshEnough(it.time)) return it }

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return lastLocation
        val latch = java.util.concurrent.CountDownLatch(1)
        val oneShotListener = object : LocationListener {
            override fun onLocationChanged(loc: Location) {
                lastLocation = loc
                latch.countDown()
                try { lm.removeUpdates(this) } catch (_: Exception) {}
            }
            @Deprecated("Deprecated in Java") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
        }
        try {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).forEach { provider ->
                if (lm.isProviderEnabled(provider))
                    lm.requestLocationUpdates(provider, 0L, 0f, oneShotListener, context.mainLooper)
            }
        } catch (_: SecurityException) { return lastLocation }

        latch.await(ONE_SHOT_WAIT_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
        try { lm.removeUpdates(oneShotListener) } catch (_: Exception) {}
        return lastLocation
    }

    fun reverseGeocode(context: Context, lat: Double, lng: Double): String? = try {
        val geocoder = android.location.Geocoder(context, java.util.Locale.getDefault())
        @Suppress("DEPRECATION")
        geocoder.getFromLocation(lat, lng, 1)
            ?.firstOrNull()
            ?.let { it.subLocality ?: it.locality ?: it.thoroughfare }
    } catch (_: Exception) { null }
}
