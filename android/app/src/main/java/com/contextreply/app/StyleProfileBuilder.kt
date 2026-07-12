package com.contextreply.app

import android.content.Context
import org.json.JSONArray

/**
 * Builds and caches a Claude-optimised writing style profile from the StyleEditQueue.
 *
 * Reads the last MAX_EDITS_FOR_PROFILE meaningful edits (original → user-sent pairs),
 * extracts word-level delta patterns, groups examples by intent and contact, then
 * writes the result to "style_profile" in contextreply_prefs for WorkerClient to include.
 *
 * Called from NativeStyleSync.syncFromQueue() after each send so the profile stays
 * current without a JS round-trip.
 */
object StyleProfileBuilder {

    private const val MAX_EDITS = 50
    private const val MIN_EDITS = 3
    private const val PATTERN_MIN_FREQ = 2  // word must appear in ≥2 edits to be a pattern
    private const val MAX_EXAMPLE_PAIRS = 6

    // ── Public API ────────────────────────────────────────────────────────────

    fun rebuild(context: Context) {
        val queue = loadQueue(context)
        val edits = extractMeaningful(queue)
        if (edits.size < MIN_EDITS) {
            Prefs.main(context).edit().remove("style_profile").apply()
            return
        }
        val profile = buildProfile(edits) ?: return
        Prefs.main(context).edit().putString("style_profile", profile).apply()
    }

    /**
     * Cheap read-only signal for UI attribution ("Matches your tone with X") — does not
     * touch the cached profile string, just re-derives counts from the same queue rebuild()
     * reads. contactSpecific mirrors buildProfile()'s own per-contact threshold (≥2 edits)
     * so the UI claim always matches what the profile actually contains.
     */
    data class ProfileSignal(val hasProfile: Boolean, val contactSpecific: Boolean)

    fun signalFor(context: Context, contact: String): ProfileSignal {
        val edits = extractMeaningful(loadQueue(context))
        val hasProfile = edits.size >= MIN_EDITS
        val contactSpecific = edits.count { it.contact.equals(contact, ignoreCase = true) } >= 2
        return ProfileSignal(hasProfile, contactSpecific)
    }

    // ── Data types ────────────────────────────────────────────────────────────

    private data class Edit(
        val original: String,
        val edit: String,
        val contact: String,
        val intent: String,
    )

    private data class Delta(
        val wordsRemoved: List<String>,
        val wordsAdded: List<String>,
        val charDelta: Int,
    )

    // ── Queue loading ─────────────────────────────────────────────────────────

    private fun loadQueue(context: Context): JSONArray = try {
        val raw = Prefs.styleQueue(context).getString("queue", "[]") ?: "[]"
        JSONArray(raw)
    } catch (_: Exception) { JSONArray() }

    private fun extractMeaningful(arr: JSONArray): List<Edit> {
        val out = mutableListOf<Edit>()
        val start = maxOf(0, arr.length() - MAX_EDITS)
        for (i in start until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val original = obj.optString("original").trim()
            val edit     = obj.optString("edit").trim()
            if (edit.isEmpty()) continue
            if (edit.equals(original, ignoreCase = true)) continue
            out.add(Edit(
                original = original,
                edit     = edit,
                contact  = obj.optString("contact").ifEmpty { "unknown" },
                intent   = obj.optString("intent").ifEmpty { "other" },
            ))
        }
        return out
    }

    // ── Delta computation ─────────────────────────────────────────────────────

    private fun computeDelta(original: String, edited: String): Delta {
        val origW = tokenize(original)
        val editW = tokenize(edited)
        val origFreq = origW.groupingBy { it }.eachCount()
        val editFreq = editW.groupingBy { it }.eachCount()

        val removed = origFreq.flatMap { (w, c) ->
            val n = c - (editFreq[w] ?: 0)
            if (n > 0) List(n) { w } else emptyList()
        }
        val added = editFreq.flatMap { (w, c) ->
            val n = c - (origFreq[w] ?: 0)
            if (n > 0) List(n) { w } else emptyList()
        }
        return Delta(removed, added, edited.length - original.length)
    }

    // Only meaningful words — skip stop words and very short tokens
    private val STOP_WORDS = setOf(
        "the", "and", "for", "are", "but", "not", "you", "all", "can",
        "had", "her", "was", "one", "our", "out", "get", "has", "him",
        "his", "how", "its", "let", "may", "new", "now", "old", "own",
        "say", "she", "too", "use", "way", "who", "did", "its", "will",
        "that", "with", "have", "this", "from", "they", "been", "some",
        "just", "what", "when", "your", "been", "into", "more", "also",
        "than", "then", "them", "were", "here", "would",
    )

    private fun tokenize(s: String): List<String> =
        s.lowercase()
            .split(Regex("[^a-z0-9']+"))
            .filter { it.length > 2 && it !in STOP_WORDS }

    // ── Profile builder ───────────────────────────────────────────────────────

    private fun buildProfile(edits: List<Edit>): String? {
        val sb = StringBuilder()

        // Aggregate word-level patterns
        val removeFreq = mutableMapOf<String, Int>()
        val addFreq    = mutableMapOf<String, Int>()
        var totalCharDelta = 0
        var totalOrigLen   = 0

        for (e in edits) {
            val d = computeDelta(e.original, e.edit)
            totalCharDelta += d.charDelta
            totalOrigLen   += e.original.length
            d.wordsRemoved.forEach { removeFreq[it] = (removeFreq[it] ?: 0) + 1 }
            d.wordsAdded.forEach   { addFreq[it]    = (addFreq[it]    ?: 0) + 1 }
        }

        val alwaysRemoves = removeFreq.entries
            .filter { it.value >= PATTERN_MIN_FREQ }
            .sortedByDescending { it.value }
            .take(6).map { "\"${it.key}\"" }
        val alwaysAdds = addFreq.entries
            .filter { it.value >= PATTERN_MIN_FREQ }
            .sortedByDescending { it.value }
            .take(6).map { "\"${it.key}\"" }

        sb.appendLine("## User Writing Style")

        // Length preference
        if (totalOrigLen > 0) {
            val pct = (totalCharDelta.toDouble() / totalOrigLen * 100).toInt()
            when {
                pct < -20 -> sb.appendLine("- Prefers much shorter replies (~${-pct}% shorter than suggested)")
                pct < -10 -> sb.appendLine("- Slightly shortens replies (~${-pct}% shorter)")
                pct >  20 -> sb.appendLine("- Prefers longer replies (~${pct}% longer than suggested)")
            }
        }

        if (alwaysRemoves.isNotEmpty())
            sb.appendLine("- Always removes: ${alwaysRemoves.joinToString(", ")}")
        if (alwaysAdds.isNotEmpty())
            sb.appendLine("- Always adds: ${alwaysAdds.joinToString(", ")}")

        // Examples by intent
        val intentLabels = mapOf(
            "eta"          to "ETA/travel",
            "availability" to "Availability",
            "other"        to "General",
        )
        var pairsWritten = 0
        val byIntent = edits.groupBy { it.intent }
        for ((intent, group) in byIntent) {
            if (pairsWritten >= MAX_EXAMPLE_PAIRS) break
            val label  = intentLabels[intent] ?: intent
            val sample = group.takeLast(2)
            sb.appendLine("\n### $label")
            for (e in sample) {
                if (pairsWritten >= MAX_EXAMPLE_PAIRS) break
                val orig = e.original.take(90)
                val edit = e.edit.take(90)
                sb.appendLine("• \"$orig\" → \"$edit\"")
                pairsWritten++
            }
        }

        // Per-contact notes (only contacts with ≥2 edits)
        val contactGroups = edits.groupBy { it.contact }
            .filterValues { it.size >= 2 }
            .entries.take(3)
        if (contactGroups.isNotEmpty()) {
            sb.appendLine("\n### Per-contact notes")
            for ((contact, group) in contactGroups) {
                val e = group.last()
                sb.appendLine("• With $contact: \"${e.original.take(60)}\" → \"${e.edit.take(60)}\"")
            }
        }

        val result = sb.toString().trim()
        return if (result.isBlank()) null else result
    }
}
