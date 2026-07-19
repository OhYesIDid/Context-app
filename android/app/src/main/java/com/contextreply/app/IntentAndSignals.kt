package com.contextreply.app

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneOffset

// Pure, stateless text-classification/scoring logic extracted from ProTxtBgService.kt (the
// first slice of its God Class split — see the audit note in that file's history). Every
// function here takes only its arguments, no Context/network/instance-state, so it's plain
// JUnit-testable without Robolectric. ProTxtBgService still owns Context-dependent state
// (the loaded intent-pattern regexes, arrivalBuffer, lastLocation, etc.) and passes it in.
object IntentAndSignals {

    // ── Debounce timing ─────────────────────────────────────────────────────────

    private const val DEBOUNCE_MS = 2_500L
    private const val DEBOUNCE_FAST_MS = 1_200L
    private const val DEBOUNCE_SLOW_MS = 4_000L

    // Trailing words that read as "more is coming" rather than a finished thought —
    // e.g. "wait" or "so" at the end of a message almost always precedes a follow-up.
    private val CONTINUATION_TRAILERS = setOf(
        "wait", "so", "and", "but", "also", "actually", "well", "um", "umm", "hmm",
        "like", "because", "cause", "coz", "plus", "though", "anyway", "anyways",
    )

    // Punctuation/word heuristic on the single message that just arrived (not the
    // whole burst) — cheapest signal available, no new tracking needed. Ends in
    // ./!/? reads as a complete thought; ends on a known continuation word or a
    // trailing comma reads as mid-sentence. Anything else keeps the default wait.
    fun computeDebounceMs(text: String): Long {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return DEBOUNCE_MS
        if (trimmed.last() in charArrayOf('.', '!', '?')) return DEBOUNCE_FAST_MS
        if (trimmed.last() == ',') return DEBOUNCE_SLOW_MS
        val lastWord = trimmed.substringAfterLast(' ').lowercase().trim(',', '.', '!', '?', ':', ';', '-')
        if (lastWord in CONTINUATION_TRAILERS) return DEBOUNCE_SLOW_MS
        return DEBOUNCE_MS
    }

    // ── Conversation-key / package helpers (external callers — see ProTxtBgService's
    //    companion-object delegates for stripAppPrefix/packageToPlatform/appLabel) ──

    // Strips "AppName: " prefixes that messaging apps prepend to contact names in their
    // notification titles (e.g. "WhatsApp: Maya Hinge" → "Maya Hinge"). Only strips
    // single-word prefixes so group names like "Ski - Val d'isere" are left intact.
    fun stripAppPrefix(key: String): String {
        val colonSpace = key.indexOf(": ")
        if (colonSpace <= 0) return key
        val prefix = key.substring(0, colonSpace)
        return if (prefix.none { it == ' ' }) key.substring(colonSpace + 2) else key
    }

    fun packageToPlatform(pkg: String): String? = when {
        pkg.contains("whatsapp")                               -> "whatsapp"
        pkg.contains("telegram")                               -> "telegram"
        pkg.contains("instagram")                              -> "instagram"
        pkg.contains("messenger") || pkg.contains("facebook")  -> "messenger"
        pkg.contains("signal")                                 -> "signal"
        pkg.contains("google.android.apps.messaging")          -> "sms"
        else -> null
    }

    fun appLabel(pkg: String): String = when {
        pkg.contains("whatsapp")                          -> "WhatsApp"
        pkg.contains("telegram")                          -> "Telegram"
        pkg.contains("hinge")                             -> "Hinge"
        pkg.contains("tinder")                            -> "Tinder"
        pkg.contains("bumble")                            -> "Bumble"
        pkg.contains("instagram")                         -> "Instagram"
        pkg.contains("messenger") || pkg.contains("facebook") -> "Messenger"
        pkg.contains("signal")                            -> "Signal"
        pkg.contains("snapchat")                          -> "Snapchat"
        pkg.contains("twitter") || pkg.contains(".x.")    -> "X"
        pkg.contains("viber")                             -> "Viber"
        pkg.contains("discord")                           -> "Discord"
        else -> pkg.substringAfterLast(".").replaceFirstChar { it.uppercase() }
    }

    // ── Intent detection ─────────────────────────────────────────────────────────
    // `patterns` is ProTxtBgService's `intentPatterns` map, loaded once from the shared
    // assets/intent_patterns.json (also consumed by src/utils/intentDetector.ts and
    // worker/src/index.ts) — loading stays in ProTxtBgService since it needs Context;
    // only the already-loaded map is passed in here.

    private fun patternsFor(patterns: Map<String, List<Regex>>, intent: String): List<Regex> =
        patterns[intent] ?: emptyList()

    fun detectIntents(patterns: Map<String, List<Regex>>, message: String): List<String> {
        val intents = mutableListOf<String>()
        if (patternsFor(patterns, "eta").any { it.containsMatchIn(message) }) intents.add("eta")
        if (patternsFor(patterns, "availability").any { it.containsMatchIn(message) }) intents.add("availability")
        if (patternsFor(patterns, "booking").any { it.containsMatchIn(message) }) intents.add("booking")
        if (patternsFor(patterns, "location_share").any { it.containsMatchIn(message) }) intents.add("location_share")
        if (patternsFor(patterns, "incoming_location").any { it.containsMatchIn(message) }) intents.add("incoming_location")
        // general is a fallback signal only — anything more specific above takes priority.
        if (intents.isEmpty() && patternsFor(patterns, "general").any { it.containsMatchIn(message) }) intents.add("general")
        return intents.ifEmpty { listOf("other") }
    }

    // Not currently called anywhere (kept as-is from the original file rather than
    // dropped, to keep this a pure move rather than a behavior/scope change).
    fun isEtaIntent(patterns: Map<String, List<Regex>>, message: String): Boolean =
        patternsFor(patterns, "eta").any { it.containsMatchIn(message) }

    private val INTENT_ENRICHMENTS = mapOf(
        "eta"               to listOf("maps"),
        "availability"      to listOf("calendar"),
        "booking"           to listOf("bookings"), // label only — no native Gmail fetch wired up yet, unlike the TS/share-sheet path
        "location_share"    to listOf("location_coords"),
        "incoming_location" to listOf("incoming_location", "maps"),
        "general"           to listOf("calendar"),
        "other"             to listOf<String>(),
    )

    fun requiredEnrichments(patterns: Map<String, List<Regex>>, message: String, intentsStr: String? = null): List<String> {
        // Use the already-resolved intents (which include inherited context) when available,
        // so follow-up messages like "ok cool" still get maps/calendar enrichments.
        val intents = if (!intentsStr.isNullOrEmpty() && intentsStr != "other")
            intentsStr.split(",").map { it.trim() }
        else
            detectIntents(patterns, message)
        return intents.flatMap { INTENT_ENRICHMENTS[it] ?: emptyList() }.distinct()
    }

    // ── Urgency scoring ──────────────────────────────────────────────────────────
    // `burstSize` is the caller's arrivalBuffer[convKey]?.size ?: 0 — the only piece of
    // instance state the original computeUrgencyScore(convKey) read, moved to the call site.

    fun computeUrgencyScore(message: String, intentsStr: String, burstSize: Int): Int {
        var score = 0
        val lc = message.lowercase()
        if (Regex("""\b(asap|urgent|emergency|immediately|right now|help me|need you now)\b""").containsMatchIn(lc)) score += 2
        if (Regex("""\b(wtf|seriously|come on|hello\?+|are you there|why aren.?t you)\b""").containsMatchIn(lc)) score += 1
        if (Regex("""\?{2,}|!{2,}""").containsMatchIn(message)) score += 1
        if (burstSize >= 2) score += 1
        if (intentsStr.contains("eta") || intentsStr.contains("availability")) score += 1
        return score.coerceIn(0, 3)
    }

    // ── Maps coordinate extraction ───────────────────────────────────────────────

    // Extracts lat/lng from a full Google or Apple Maps URL. Returns null for short URLs.
    fun extractMapsCoordinates(text: String): Pair<Double, Double>? {
        val patterns = listOf(
            Regex("""@(-?\d+\.\d+),(-?\d+\.\d+)"""),                    // /place/Name/@lat,lng,zoom
            Regex("""[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)"""),               // ?q=lat,lng
            Regex("""[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)"""),              // Apple Maps ?ll=lat,lng
            Regex("""(-?\d{1,3}\.\d{5,})\s*,\s*(-?\d{1,3}\.\d{5,})"""), // raw coords
        )
        for (pattern in patterns) {
            val m = pattern.find(text) ?: continue
            val lat = m.groupValues[1].toDoubleOrNull() ?: continue
            val lon = m.groupValues[2].toDoubleOrNull() ?: continue
            if (lat in -90.0..90.0 && lon in -180.0..180.0) return Pair(lat, lon)
        }
        return null
    }

    // Extracts a Maps short URL that the worker must resolve to get coordinates.
    fun extractShortMapsUrl(text: String): String? =
        Regex("""https?://(?:maps\.app\.goo\.gl|goo\.gl/maps)/\S+""").find(text)?.value

    // ── Emotional charge detection ───────────────────────────────────────────────

    fun detectEmotionalCharge(message: String, thread: List<Pair<String?, String>>): JSONObject? {
        // Combine the current message with the last 2 inbound messages for better signal on
        // short replies like "k" that only make sense in context.
        val recentInbound = thread.takeLast(3)
            .filter { (sender, _) -> sender != null }
            .map { it.second }
        val corpus = (recentInbound + message).joinToString(" ")

        data class Signal(val emotion: String, val patterns: List<Regex>)

        val highConfidence = listOf(
            Signal("anger", listOf(
                Regex("""!{2,}"""),
                Regex("""\b(hate|furious|disgusting|unbelievable|ridiculous|pathetic|useless|terrible|awful|pissed)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(can'?t believe|so done|fed up|had enough|not okay|not ok|done with)\b""", RegexOption.IGNORE_CASE),
                Regex("""(?<![a-z])[A-Z]{4,}(?![a-z])"""),  // SHOUTING
            )),
            Signal("urgency", listOf(
                Regex("""\b(urgent|asap|emergency|right now|immediately|hurry|need you now)\b""", RegexOption.IGNORE_CASE),
                Regex("""\?{2,}"""),
            )),
            Signal("anxiety", listOf(
                Regex("""\b(worried|scared|anxious|nervous|panicking|freaking out|stressed|terrified)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(are you okay|you alright|is everything ok|what happened|hope you'?re ok)\b""", RegexOption.IGNORE_CASE),
            )),
        )

        val lowConfidence = listOf(
            Signal("frustration", listOf(
                Regex("""\b(ugh|sigh|smh|ffs|seriously|really\?)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(tired of|sick of|again\?|always|never listens)\b""", RegexOption.IGNORE_CASE),
            )),
            Signal("passive_agg", listOf(
                Regex("""\b(fine|whatever|k|sure|ok)\b\.?\s*$""", RegexOption.IGNORE_CASE),
                Regex("""\.{3,}$"""),  // trailing ellipsis on short message
            )),
        )

        // High-confidence: check full corpus (message + recent thread)
        for ((emotion, patterns) in highConfidence) {
            if (patterns.any { it.containsMatchIn(corpus) }) {
                return JSONObject().apply {
                    put("emotion", emotion)
                    put("confidence", "high")
                }
            }
        }

        // Low-confidence: only trigger on short messages (< 30 chars) to reduce false positives
        if (message.trim().length < 30) {
            for ((emotion, patterns) in lowConfidence) {
                if (patterns.any { it.containsMatchIn(message) }) {
                    return JSONObject().apply {
                        put("emotion", emotion)
                        put("confidence", "low")
                    }
                }
            }
        }

        return null
    }

    // ── Calendar keyword / date extraction ───────────────────────────────────────

    fun extractEventKeyword(message: String): String? {
        val patterns = listOf(
            Regex("""when (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""what (?:day|time|date) (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""what (?:is|are) the (?:day|time|date) (?:of|for)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""remind me (?:about|of)(?: my| the)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            // "What time does doodies bday start?" / "When does the party kick off?"
            Regex("""what (?:day|time|date) does (.+?) (?:start|begin|kick off|happen|take place)\b""", RegexOption.IGNORE_CASE),
            Regex("""when does (.+?) (?:start|begin|kick off|happen|take place)\b""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { re ->
            re.find(message)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.length > 1 && it.length < 50 }
        }
    }

    fun extractSearchTerm(keyword: String): String {
        val stopwords = setOf("my", "the", "a", "an", "our", "your", "his", "her", "their", "its")
        val words = keyword.split(Regex("\\s+"))
        val word = words.firstOrNull { !stopwords.contains(it.lowercase().replace(Regex("'s$"), "")) } ?: words[0]
        return word.replace(Regex("'s$", RegexOption.IGNORE_CASE), "")
    }

    // ── Contact cross-app link check ─────────────────────────────────────────────
    // A small pure helper from the contact-linking flow (contactMatchJson stays in
    // ProTxtBgService — it reads/writes SharedPreferences and calls ContactMatcher, both
    // Context-dependent; this piece of its logic needed neither).

    // Returns (true, sourcePkg) when contactId is already linked from a different package.
    // Synthetic auto:/sep: IDs are per-sender and never constitute a cross-app link.
    fun crossAppLink(contactId: String, currentConvKey: String, confirmed: JSONObject): Pair<Boolean, String> {
        if (contactId.startsWith("auto:") || contactId.startsWith("sep:")) return false to ""
        val currentPkg = currentConvKey.substringBefore(":")
        for (key in confirmed.keys()) {
            if (confirmed.optString(key) == contactId) {
                val existingPkg = key.substringBefore(":")
                if (existingPkg != currentPkg) return true to existingPkg
            }
        }
        return false to ""
    }

    // ── Destination extraction ───────────────────────────────────────────────────

    // Words that look like destinations when extracted but are not routable place names.
    private val DESTINATION_NOISE = setOf(
        "you", "us", "me", "them", "here", "there", "it", "that", "this",
        "the area", "your place",
    )

    // Shared with ProTxtBgService's fetchEtaData, which checks a resolved destination
    // against this same set before deciding whether to route to the saved home address.
    val HOME_KEYWORDS = setOf(
        "home", "my place", "my house", "my flat", "my apartment", "my home",
    )

    // A leading time-of-day mention ("meeting at 9pm at McDonald's") gets swept up by the
    // "at X" pattern below matching the EARLIER "at" (before the time) rather than the one
    // right before the actual place, producing "9pm at McDonald's" — a string starting with
    // a time expression that the Directions API won't resolve as an address at all, causing
    // the whole ETA lookup to silently fail. Stripped back off rather than passed through.
    private val DESTINATION_TIME_PREFIX = Regex("""^\d{1,2}(:\d{2})?\s?(am|pm)?\s+at\s+""", RegexOption.IGNORE_CASE)

    fun extractDestination(message: String): String? {
        val patterns = listOf(
            Regex("""(?:how far|far) (?:are you |is it )?(?:from|to) (.+?)(?:\?|,|$)""", RegexOption.IGNORE_CASE),
            Regex("""(?:near|at|by|in|outside|around) (.+?)(?:\?|,|\. | are | is | and | - |$)""", RegexOption.IGNORE_CASE),
            Regex("""distance (?:from|to) (.+?)(?:\?|,|$)""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { re ->
            val found = re.find(message)?.groupValues?.getOrNull(1)?.trim() ?: return@firstNotNullOfOrNull null
            val raw = found.replace(DESTINATION_TIME_PREFIX, "").trim()
            // Reject noise words and overly long / short extractions
            if (raw.length < 2 || raw.length > 60) return@firstNotNullOfOrNull null
            if (DESTINATION_NOISE.any { raw.equals(it, ignoreCase = true) }) return@firstNotNullOfOrNull null
            // Reject if the extracted text reads like a sentence fragment (contains a verb phrase)
            if (Regex("""\b(are|is|do|will|can|have|going)\b""", RegexOption.IGNORE_CASE).containsMatchIn(raw)) return@firstNotNullOfOrNull null
            raw
        }
    }

    fun isPastTemporalQuery(message: String): Boolean = listOf(
        Regex("""\blast\s+(week|month|friday|thursday|wednesday|tuesday|monday|weekend|night)\b""", RegexOption.IGNORE_CASE),
        Regex("""\byesterday\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(did you|were you|was it|how was|how did|did it go)\b""", RegexOption.IGNORE_CASE),
    ).any { it.containsMatchIn(message) }

    // Extracts a specific date anchor from the message (e.g. "30th July", "July 30").
    // Returns an Instant at midnight UTC on that date in the current year (or next year if the
    // date has already passed this year), or null if no specific date is found.
    // `today` defaults to the real current date in production; tests inject a fixed date for
    // deterministic "already passed this year" rollover behavior.
    fun extractMentionedDate(message: String, today: LocalDate = LocalDate.now()): Instant? {
        val monthNames = mapOf(
            "jan" to 1, "feb" to 2, "mar" to 3, "apr" to 4, "may" to 5, "jun" to 6,
            "jul" to 7, "aug" to 8, "sep" to 9, "oct" to 10, "nov" to 11, "dec" to 12,
            "january" to 1, "february" to 2, "march" to 3, "april" to 4, "june" to 6,
            "july" to 7, "august" to 8, "september" to 9, "october" to 10, "november" to 11, "december" to 12,
        )
        val patterns = listOf(
            // "30th July", "2nd August", "21st March"
            Regex("""(\d{1,2})(?:st|nd|rd|th)?\s+(${monthNames.keys.joinToString("|")})""", RegexOption.IGNORE_CASE),
            // "July 30", "August 2"
            Regex("""(${monthNames.keys.joinToString("|")})\s+(\d{1,2})(?:st|nd|rd|th)?""", RegexOption.IGNORE_CASE),
        )
        for (re in patterns) {
            val m = re.find(message) ?: continue
            val (day, month) = if (m.groupValues[1].toIntOrNull() != null)
                m.groupValues[1].toInt() to (monthNames[m.groupValues[2].lowercase()] ?: continue)
            else
                m.groupValues[2].toInt() to (monthNames[m.groupValues[1].lowercase()] ?: continue)
            if (day < 1 || day > 31) continue
            var candidate = LocalDate.of(today.year, month, minOf(day, YearMonth.of(today.year, month).lengthOfMonth()))
            // If the date has already passed this year, use next year
            if (candidate.isBefore(today)) candidate = candidate.withYear(today.year + 1)
            return candidate.atStartOfDay(ZoneOffset.UTC).toInstant()
        }
        return null
    }
}
