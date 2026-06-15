package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import kotlin.math.max
import kotlin.math.min

data class MatchResult(
    val contactId: String,
    val displayName: String,
    val preferredTone: String?,
    val confidence: Double,
)

object ContactMatcher {

    private const val AUTO_APPLY  = 0.88
    private const val MIN_MATCH   = 0.70

    private val PHONE_RE = Regex("""^[+\d][\d\s\-().]{5,}$""")

    fun isPhoneNumber(s: String) = PHONE_RE.matches(s) && s.count { it.isDigit() } >= 7

    /**
     * If [phone] is a raw phone number, resolves it via ContactsContract PhoneLookup and returns
     * a confidence-1.0 match. Also picks up preferred_tone if the resolved name is in the cache.
     */
    fun bestMatchByPhone(context: Context, phone: String): MatchResult? {
        if (!isPhoneNumber(phone)) return null
        val displayName = DeviceContactsResolver.phoneToDisplayName(context, phone) ?: return null
        val toneMatch = bestMatch(context, displayName)
        return MatchResult(
            contactId    = toneMatch?.contactId ?: "device:phone",
            displayName  = displayName,
            preferredTone = toneMatch?.preferredTone,
            confidence   = 1.0,
        )
    }

    /** Returns the preferred tone for `senderName` if confidence ≥ AUTO_APPLY, else null. */
    fun preferredTone(context: Context, senderName: String): String? {
        val match = bestMatch(context, senderName) ?: return null
        return if (match.confidence >= AUTO_APPLY) match.preferredTone else null
    }

    /** Returns the highest-confidence contact match ≥ MIN_MATCH, or null. */
    fun bestMatch(context: Context, senderName: String): MatchResult? {
        if (senderName.isBlank()) return null
        val cache = loadCache(context)
        if (cache.length() == 0) return null

        val needle = senderName.trim().lowercase()
        var best: MatchResult? = null

        for (i in 0 until cache.length()) {
            val obj = cache.optJSONObject(i) ?: continue
            val id = obj.optString("id")
            if (id.isEmpty()) continue
            val displayName = obj.optString("display_name")
            if (displayName.isEmpty()) continue
            val tone = obj.optString("preferred_tone").takeIf { it.isNotEmpty() }

            val haystack = displayName.trim().lowercase()
            val score = max(jaroWinkler(needle, haystack), tokenSortJaroWinkler(needle, haystack))

            if (score >= MIN_MATCH && (best == null || score > best.confidence)) {
                best = MatchResult(id, displayName, tone, score)
            }
        }

        return best
    }

    private fun loadCache(context: Context): JSONArray = try {
        val prefs = context.getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
        val appCache = JSONArray(prefs.getString("contact_cache", "[]") ?: "[]")
        if (appCache.length() > 0) appCache
        else JSONArray(prefs.getString("device_contact_cache", "[]") ?: "[]")
    } catch (_: Exception) { JSONArray() }

    // ── Jaro-Winkler ────────────────────────────────────────────────────────

    private fun jaroWinkler(s1: String, s2: String): Double {
        val j = jaro(s1, s2)
        val maxPre = min(4, min(s1.length, s2.length))
        var prefix = 0
        while (prefix < maxPre && s1[prefix] == s2[prefix]) prefix++
        return j + prefix * 0.1 * (1.0 - j)
    }

    private fun jaro(s1: String, s2: String): Double {
        if (s1 == s2) return 1.0
        val len1 = s1.length
        val len2 = s2.length
        if (len1 == 0 || len2 == 0) return 0.0
        val window = max(len1, len2) / 2 - 1
        val m1 = BooleanArray(len1)
        val m2 = BooleanArray(len2)
        var matches = 0
        for (i in 0 until len1) {
            val lo = max(0, i - window)
            val hi = min(i + window + 1, len2)
            for (j in lo until hi) {
                if (m2[j] || s1[i] != s2[j]) continue
                m1[i] = true; m2[j] = true; matches++; break
            }
        }
        if (matches == 0) return 0.0
        var transpositions = 0
        var k = 0
        for (i in 0 until len1) {
            if (!m1[i]) continue
            while (!m2[k]) k++
            if (s1[i] != s2[k]) transpositions++
            k++
        }
        val m = matches.toDouble()
        return (m / len1 + m / len2 + (m - transpositions / 2.0) / m) / 3.0
    }

    // Handles transposed names: "Smith John" vs "John Smith"
    private fun tokenSortJaroWinkler(s1: String, s2: String): Double {
        fun sorted(s: String) = s.split(Regex("\\s+")).sorted().joinToString(" ")
        return jaroWinkler(sorted(s1), sorted(s2))
    }
}
