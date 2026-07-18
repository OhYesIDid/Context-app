package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import java.util.Calendar

/**
 * Reads the "native_upcoming_bookings" cache written by upcomingEvents.ts
 * (ProTxtSettingsModule.syncUpcomingBookings) and turns imminent bookings
 * into ETA destination candidates — the same shape ContactMemory's
 * destination-memory system already produces, so both feed the same
 * single/multiple/Claude-picks resolution logic in
 * ProTxtBgService.buildEnrichments's "maps" case.
 *
 * This is what lets "Paul: ETA?" resolve to Brighton when there's a same-day
 * train booking to Brighton, even though nothing in the visible thread names
 * a destination and no prior message in this conversation ever resolved one.
 */
data class TripWindow(val destination: String, val type: String, val travelDate: Long, val travelDateEnd: Long)

object BookingDestinations {

    fun candidates(context: Context): List<DestinationCandidate> {
        val raw = Prefs.main(context).getString("native_upcoming_bookings", null) ?: return emptyList()
        val now = System.currentTimeMillis()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val destination = o.optString("destination").ifEmpty { null } ?: return@mapNotNull null
                val type = o.optString("type").ifEmpty { "trip" }
                val travelDate = parseIso(o.optString("travelDate").ifEmpty { null }) ?: return@mapNotNull null
                val travelDateEnd = parseIso(o.optString("travelDateEnd").ifEmpty { null }) ?: travelDate
                if (!isTodayOrUnderway(travelDate, travelDateEnd, now)) return@mapNotNull null
                // Label carries the booking context inline (no schema change needed downstream —
                // the same {label, duration, distance, routeSummary, mentionedMinutesAgo} JSON
                // that memory-sourced candidates already send to Claude).
                DestinationCandidate(
                    label = "$destination ($type today)",
                    destinationText = destination,
                    mentionedAt = now,
                )
            }
        } catch (_: Exception) { emptyList() }
    }

    /**
     * Finds a cached booking whose destination matches [destinationHint] (case-insensitive
     * substring either direction, so "Brighton" matches "Brighton, UK" and vice versa) and
     * returns its trip window — specifically the return date — regardless of whether the
     * trip is happening today. Lets buildEnrichments distinguish "how far away are you right
     * now" (live ETA) from "when do you get back from X" (this), for the same destination.
     */
    fun matchingTrip(context: Context, destinationHint: String?): TripWindow? {
        if (destinationHint.isNullOrBlank()) return null
        val raw = Prefs.main(context).getString("native_upcoming_bookings", null) ?: return null
        val hint = destinationHint.trim().lowercase()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val destination = o.optString("destination").ifEmpty { null } ?: return@mapNotNull null
                val destLower = destination.trim().lowercase()
                if (!hint.contains(destLower) && !destLower.contains(hint)) return@mapNotNull null
                val type = o.optString("type").ifEmpty { "trip" }
                val travelDate = parseIso(o.optString("travelDate").ifEmpty { null }) ?: return@mapNotNull null
                val travelDateEnd = parseIso(o.optString("travelDateEnd").ifEmpty { null }) ?: travelDate
                TripWindow(destination = destination, type = type, travelDate = travelDate, travelDateEnd = travelDateEnd)
            }.maxByOrNull { it.travelDateEnd }
        } catch (_: Exception) { null }
    }

    private fun parseIso(iso: String?): Long? {
        if (iso.isNullOrEmpty()) return null
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            try { java.time.LocalDate.parse(iso.take(10)).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli() }
            catch (_: Exception) { null }
        }
    }

    /** True if travelDate falls on today's calendar date, or today sits inside a multi-day trip's span. */
    private fun isTodayOrUnderway(startMs: Long, endMs: Long, nowMs: Long): Boolean {
        fun dayStart(ms: Long): Long {
            val cal = Calendar.getInstance()
            cal.timeInMillis = ms
            cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
            cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }
        val today = dayStart(nowMs)
        return dayStart(startMs) == today || (startMs <= nowMs && endMs >= nowMs)
    }
}
