package com.contextreply.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import kotlin.math.pow

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

    // ── Closeness score (Phase D — research-contact-source-of-truth memory) ────
    //
    // Formalizes three of the four signals getContactContext() already renders as text —
    // recency, frequency, reply speed — into a single stored 0.0-1.0 number instead of a
    // regenerate-on-read prompt string, so the JS side has a real value to persist and
    // roll up across a contact's linked platforms (see contactCloseness.ts). Deliberately
    // excludes the 4th signal (weekday/daytime contact pattern): that's a categorical
    // tone-fit signal (professional vs personal), not a "more or less" closeness
    // magnitude, so it has no natural place in a single scalar.
    //
    // Pure and internal (not private) so it's unit-testable without a Context —
    // getClosenessScore() below is the only production caller.
    internal fun closenessScore(obj: JSONObject, now: Long): Double? {
        val tsArr = obj.optJSONArray("ts") ?: return null
        if (tsArr.length() == 0) return null
        val timestamps = (0 until tsArr.length()).map { tsArr.getLong(it) }
        val last = timestamps.last()

        // Recency: exponential decay, 14-day half-life — matches the style-learning
        // profile's own recency decay elsewhere in the app. Fresher reads as closer.
        val sinceDays = (now - last) / 86_400_000.0
        val recency = 0.5.pow(sinceDays / 14.0).coerceIn(0.0, 1.0)

        // Frequency: last-7-day volume, capped — 20+ msgs/week reads as maximally frequent.
        val week1Start = now - 7L * 86_400_000L
        val r7 = timestamps.count { it >= week1Start }
        val frequency = (r7 / 20.0).coerceIn(0.0, 1.0)

        // Reciprocity: average reply latency, only when there's enough data to trust it —
        // absence of delay data means "not enough replies sent yet," not "distant," so it's
        // excluded (weight redistributed to the other two) rather than defaulted to 0.
        val delays = obj.optJSONArray("delays")
        val reciprocity = if (delays != null && delays.length() >= 2) {
            val avgSecs = (0 until delays.length()).map { delays.getInt(it) }.average()
            when {
                avgSecs < 60      -> 1.0
                avgSecs < 1_800   -> 0.85
                avgSecs < 3_600   -> 0.7
                avgSecs < 86_400  -> 0.4
                else              -> 0.15
            }
        } else null

        return if (reciprocity != null) {
            recency * 0.35 + frequency * 0.35 + reciprocity * 0.30
        } else {
            recency * 0.5 + frequency * 0.5
        }
    }

    /** Returns the stored closeness score (0.0-1.0) for this convKey, or null if there's no data yet. */
    fun getClosenessScore(context: Context, convKey: String): Double? {
        val obj = try { load(Prefs.main(context), sigKey(convKey)) } catch (_: Exception) { return null }
        return closenessScore(obj, System.currentTimeMillis())
    }

    // ── Per-contact insights (IDEAS.md "Per-contact data insights") ────────────
    //
    // Raw numbers behind getContactContext()'s prose, for display rather than prompt
    // injection — msgsLast7d/msgsPrior7d and avgReplySecs reuse the exact same math as
    // the volume-trend and reply-speed sections above; mostActiveHour is a new
    // aggregation (mode of hour-of-day) over timestamps already being collected, no new
    // tracking needed. Pure and internal so it's unit-testable without a Context —
    // getInsights() below is the only production caller.
    internal fun computeInsights(obj: JSONObject, now: Long): JSONObject? {
        val tsArr = obj.optJSONArray("ts") ?: return null
        if (tsArr.length() == 0) return null
        val timestamps = (0 until tsArr.length()).map { tsArr.getLong(it) }

        val week1Start = now - 7L * 86_400_000L
        val week2Start = now - 14L * 86_400_000L
        val msgsLast7d = timestamps.count { it >= week1Start }
        val msgsPrior7d = timestamps.count { it in week2Start until week1Start }

        val delays = obj.optJSONArray("delays")
        val avgReplySecs = if (delays != null && delays.length() >= 2) {
            (0 until delays.length()).map { delays.getInt(it) }.average().toInt()
        } else null

        // Mode of hour-of-day — same >=5-sample threshold as the weekday/daytime pattern
        // signal in getContactContext(), below which a single outlier hour would be
        // presented as a confident pattern it isn't.
        val mostActiveHour = if (timestamps.size >= 5) {
            val cal = Calendar.getInstance()
            val counts = IntArray(24)
            for (ts in timestamps) {
                cal.timeInMillis = ts
                counts[cal.get(Calendar.HOUR_OF_DAY)]++
            }
            counts.indices.maxByOrNull { counts[it] }
        } else null

        return JSONObject().apply {
            put("msgsLast7d", msgsLast7d)
            put("msgsPrior7d", msgsPrior7d)
            if (avgReplySecs != null) put("avgReplySecs", avgReplySecs)
            if (mostActiveHour != null) put("mostActiveHour", mostActiveHour)
        }
    }

    /** Returns raw insight numbers for this convKey as a JSON object, or null if there's no data yet. */
    fun getInsights(context: Context, convKey: String): JSONObject? {
        val obj = try { load(Prefs.main(context), sigKey(convKey)) } catch (_: Exception) { return null }
        return computeInsights(obj, System.currentTimeMillis())
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
