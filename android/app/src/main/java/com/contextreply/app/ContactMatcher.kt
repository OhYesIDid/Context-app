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

    internal const val AUTO_APPLY  = 0.88
    private const val MIN_MATCH   = 0.70

    private val PHONE_RE = Regex("""^[+\d][\d\s\-().]{5,}$""")

    fun isPhoneNumber(s: String) = PHONE_RE.matches(s) && s.count { it.isDigit() } >= 7

    /**
     * If [phone] is a raw phone number, resolves it via ContactsContract PhoneLookup and returns
     * a confidence-1.0 match. Also picks up preferred_tone if the resolved name is in the cache.
     */
    fun bestMatchByPhone(context: Context, phone: String): MatchResult? {
        if (!isPhoneNumber(phone)) return null
        val raw = DeviceContactsResolver.phoneToDisplayName(context, phone) ?: return null
        val displayName = ProTxtBgService.stripAppPrefix(raw)
        val toneMatch = bestMatch(context, displayName)
        return MatchResult(
            contactId     = toneMatch?.contactId ?: "device:phone",
            displayName   = displayName,
            preferredTone = toneMatch?.preferredTone,
            confidence    = 1.0,
        )
    }

    /** Returns the preferred tone for `senderName` if confidence ≥ AUTO_APPLY, else null. */
    fun preferredTone(context: Context, senderName: String): String? {
        val match = bestMatch(context, senderName) ?: return null
        return if (match.confidence >= AUTO_APPLY) match.preferredTone else null
    }

    /** Returns the highest-confidence contact match ≥ MIN_MATCH, or null. */
    fun bestMatch(context: Context, senderName: String): MatchResult? =
        bestMatches(context, senderName, 1).firstOrNull()

    /** Returns up to [limit] matches ≥ MIN_MATCH, sorted by confidence descending. */
    fun bestMatches(context: Context, senderName: String, limit: Int = 3): List<MatchResult> {
        if (senderName.isBlank()) return emptyList()
        val cache = loadCache(context)
        if (cache.length() == 0) return emptyList()

        val results = mutableListOf<MatchResult>()

        for (i in 0 until cache.length()) {
            val obj = cache.optJSONObject(i) ?: continue
            val id = obj.optString("id")
            if (id.isEmpty()) continue
            val displayName = obj.optString("display_name")
            if (displayName.isEmpty()) continue
            val tone = obj.optString("preferred_tone").takeIf { it.isNotEmpty() }

            // Strip app prefixes from cached names (e.g. WhatsApp contacts saved as "WhatsApp: Name")
            val cleanName = ProTxtBgService.stripAppPrefix(displayName.trim())
            val score = nameScore(senderName, cleanName)

            if (score >= MIN_MATCH) results.add(MatchResult(id, cleanName, tone, score))
        }

        return results.sortedByDescending { it.confidence }.take(limit)
    }

    private fun loadCache(context: Context): JSONArray = try {
        val prefs = Prefs.main(context)
        val appCache = JSONArray(prefs.getString("contact_cache", "[]") ?: "[]")
        val deviceCache = JSONArray(prefs.getString("device_contact_cache", "[]") ?: "[]")
        when {
            appCache.length() == 0 -> deviceCache
            deviceCache.length() == 0 -> appCache
            else -> JSONArray().also { merged ->
                // App cache first — has tone + interaction data.
                // Device cache fills gaps for contacts not yet imported into the app.
                val appIds = (0 until appCache.length())
                    .mapNotNull { appCache.optJSONObject(it)?.optString("id") }.toSet()
                for (i in 0 until appCache.length()) merged.put(appCache.get(i))
                for (i in 0 until deviceCache.length()) {
                    val obj = deviceCache.optJSONObject(i) ?: continue
                    if (!appIds.contains(obj.optString("id"))) merged.put(obj)
                }
            }
        }
    } catch (_: Exception) { JSONArray() }

    // ── Name scoring (Phase C — research-contact-source-of-truth memory) ──────
    //
    // Best similarity between a raw sender name and a candidate contact name, across
    // several independent-ish comparisons: the two variants bestMatches() always ran
    // (raw and sorted-token Jaro-Winkler, for transposed names), plus two added here —
    // handle-separator normalization and first-name-only comparison — both aimed at
    // the same gap flagged in IDEAS.md's Cross-Platform Contact Linking section:
    // "Tom Smith" (device contact) vs "@tom.smith" / "tommyg" (a platform's own display
    // name) read as the same person to a human but score poorly as opaque strings.
    // Internal, not private, so it's unit-testable without a Context — bestMatches()
    // above is the only production caller. Deliberately does NOT change MIN_MATCH/
    // AUTO_APPLY, and ContactLinking.kt's rule that a name-only match (this whole tier)
    // never auto-confirms regardless of score is unchanged — a stronger signal here
    // only changes which banner wording is used ("Is this X?" vs "Possibly X?"), not
    // whether a banner is shown at all.
    internal fun nameScore(rawSenderName: String, candidateName: String): Double {
        val needle = rawSenderName.trim().lowercase()
        val haystack = candidateName.trim().lowercase()
        if (needle.isEmpty() || haystack.isEmpty()) return 0.0

        var best = max(jaroWinkler(needle, haystack), tokenSortJaroWinkler(needle, haystack))

        // Handle-style senders ("@tom.smith", "tom_smith") — split on separators and
        // compare as space-joined name tokens instead of one opaque string.
        val normalized = normalizeHandle(needle)
        if (normalized != needle) {
            best = max(best, max(jaroWinkler(normalized, haystack), tokenSortJaroWinkler(normalized, haystack)))
        }

        // Compact single-token senders with no separator at all ("tommyg", "tomsmith") —
        // compare against just the candidate's first name, where Jaro-Winkler's
        // shared-prefix bonus can still catch a contraction a full-string compare misses.
        if (' ' !in needle) {
            val firstToken = haystack.substringBefore(' ')
            if (firstToken.isNotEmpty() && firstToken != haystack) {
                best = max(best, jaroWinkler(needle, firstToken))
            }
        }

        return best
    }

    // "@tom.smith99" / "tom_smith" -> "tom smith" — strips a leading '@', splits on common
    // handle separators, and drops pure-digit tokens (usually a disambiguating suffix, not
    // part of a name). A no-op input (no '@', no separators) returns itself unchanged.
    private fun normalizeHandle(s: String): String {
        val stripped = s.removePrefix("@")
        val tokens = stripped.split(Regex("[._-]+")).filter { it.isNotBlank() && it.any(Char::isLetter) }
        return if (tokens.isEmpty()) s else tokens.joinToString(" ")
    }

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
