package com.contextreply.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * Tracks zero-permission contact signals derived from notification timestamps:
 *  • Relationship age + time since last message
 *  • 7-day vs prior-7-day volume trend
 *  • Reply speed (median latency from their message to our send)
 *  • Contact pattern (weekday/daytime ratio → professional vs personal)
 *
 * All data is stored per-convKey in Prefs.main under "sig_<convKey>" as a small JSON blob.
 * getContactContext() returns a single-line string ready for injection into the worker prompt.
 */
object ContactSignals {

    private const val MAX_TS = 30       // rolling window of timestamps kept
    private const val MAX_DELAYS = 10   // reply latencies kept per contact

    private fun sigKey(convKey: String) =
        "sig_" + convKey.replace(Regex("[^a-zA-Z0-9_:.-]"), "_").take(180)

    // ── Write side ────────────────────────────────────────────────────────────

    fun recordIncoming(context: Context, convKey: String) {
        try {
            val now = System.currentTimeMillis()
            val prefs = Prefs.main(context)
            val key = sigKey(convKey)
            val obj = load(prefs, key)

            if (obj.optLong("first", 0L) == 0L) obj.put("first", now)

            val tsArr = obj.optJSONArray("ts") ?: JSONArray()
            tsArr.put(now)
            obj.put("ts", trim(tsArr, MAX_TS))

            // pendingArrival: reset on each incoming so we measure latency from the latest message
            obj.put("pendingArrival", now)

            prefs.edit().putString(key, obj.toString()).apply()
        } catch (_: Exception) {}
    }

    fun recordReply(context: Context, convKey: String) {
        try {
            val now = System.currentTimeMillis()
            val prefs = Prefs.main(context)
            val key = sigKey(convKey)
            val obj = load(prefs, key)

            val arrived = obj.optLong("pendingArrival", 0L)
            if (arrived > 0L) {
                // Cap at 24 h — anything longer is probably not a real reply to this specific message
                val delaySecs = ((now - arrived) / 1_000L).toInt().coerceIn(0, 86_400)
                val delays = obj.optJSONArray("delays") ?: JSONArray()
                delays.put(delaySecs)
                obj.put("delays", trim(delays, MAX_DELAYS))
                obj.remove("pendingArrival")
                prefs.edit().putString(key, obj.toString()).apply()
            }
        } catch (_: Exception) {}
    }

    // ── Read side ─────────────────────────────────────────────────────────────

    fun getContactContext(context: Context, convKey: String): String? {
        val obj = try { load(Prefs.main(context), sigKey(convKey)) } catch (_: Exception) { return null }
        val tsArr = obj.optJSONArray("ts") ?: return null
        if (tsArr.length() == 0) return null

        val now = System.currentTimeMillis()
        val first = obj.optLong("first", 0L)
        val timestamps = (0 until tsArr.length()).map { tsArr.getLong(it) }
        val last = timestamps.last()

        val parts = mutableListOf<String>()

        // 1. Relationship age + last contact
        val ageDays = (now - first) / 86_400_000L
        val sinceMs  = now - last
        val ageStr = when {
            ageDays < 1   -> "today"
            ageDays < 7   -> "${ageDays}d"
            ageDays < 30  -> "${ageDays / 7}wk"
            ageDays < 365 -> "${ageDays / 30}mo"
            else          -> "${ageDays / 365}yr"
        }
        val sinceStr = when {
            sinceMs < 60_000       -> "just now"
            sinceMs < 3_600_000    -> "${sinceMs / 60_000}min ago"
            sinceMs < 86_400_000   -> "${sinceMs / 3_600_000}h ago"
            sinceMs < 7 * 86_400_000L -> "${sinceMs / 86_400_000}d ago"
            else                   -> "${sinceMs / (7 * 86_400_000L)}wk ago"
        }
        parts.add("Contact known ${ageStr}, last message $sinceStr")

        // 2. Volume trend
        val week1Start = now - 7L * 86_400_000L
        val week2Start = now - 14L * 86_400_000L
        val r7 = timestamps.count { it >= week1Start }
        val p7 = timestamps.count { it in week2Start until week1Start }
        when {
            r7 > 0 && p7 == 0 -> parts.add("$r7 msgs this week (new or dormant contact)")
            r7 > 0 && r7 >= p7 * 2 -> parts.add("$r7 msgs/7d (↑ from $p7 prior week)")
            r7 > 0 && p7 > 0 && p7 >= r7 * 2 -> parts.add("$r7 msgs/7d (↓ from $p7 prior week)")
            r7 > 0 -> parts.add("$r7 msgs/7d")
        }

        // 3. Reply speed
        val delays = obj.optJSONArray("delays")
        if (delays != null && delays.length() >= 2) {
            val avgSecs = (0 until delays.length()).map { delays.getInt(it) }.average().toInt()
            val speed = when {
                avgSecs < 60       -> "replies within 1 min"
                avgSecs < 1_800    -> "typically replies in ~${avgSecs / 60} min"
                avgSecs < 3_600    -> "typically replies in ~${avgSecs / 60} min"
                avgSecs < 86_400   -> "typically replies in ~${avgSecs / 3_600}h"
                else               -> "slow to reply (often >1d)"
            }
            parts.add(speed)
        }

        // 4. Contact pattern
        if (timestamps.size >= 5) {
            val cal = Calendar.getInstance()
            var weekdayCount = 0
            var daytimeCount = 0
            for (ts in timestamps) {
                cal.timeInMillis = ts
                val dow = cal.get(Calendar.DAY_OF_WEEK)
                val hour = cal.get(Calendar.HOUR_OF_DAY)
                if (dow in Calendar.MONDAY..Calendar.FRIDAY) weekdayCount++
                if (hour in 9..17) daytimeCount++
            }
            val wdPct = weekdayCount * 100 / timestamps.size
            val dtPct = daytimeCount * 100 / timestamps.size
            when {
                wdPct >= 75 && dtPct >= 60 ->
                    parts.add("mostly weekday daytime — likely professional, prefer formal tone")
                wdPct <= 35 ->
                    parts.add("mostly evenings/weekends — personal contact, casual tone fits")
            }
        }

        return "Contact signals: ${parts.joinToString(". ")}."
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun load(prefs: SharedPreferences, key: String): JSONObject {
        val raw = prefs.getString(key, null) ?: return JSONObject()
        return try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
    }

    private fun trim(arr: JSONArray, max: Int): JSONArray {
        if (arr.length() <= max) return arr
        val start = arr.length() - max
        val result = JSONArray()
        for (i in start until arr.length()) result.put(arr.get(i))
        return result
    }
}
