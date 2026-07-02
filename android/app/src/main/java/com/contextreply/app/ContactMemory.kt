package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Persists contact memory keyed by contactId (cross-platform) with fallback to convKey.
 *
 * Schema per key:
 *   {
 *     "summary": "Planning birthday dinner Saturday; she's vegetarian",
 *     "entries": [
 *       { "ts": 1750012800, "text": "Birthday dinner at The Ivy Saturday 7pm" },
 *       { "ts": 1750012800, "text": "She's vegetarian, prefers somewhere quiet" }
 *     ]
 *   }
 *
 * Entries are pruned to the last 90 days or last 30 items, whichever is fewer,
 * with a floor of 10 most-recent entries always retained.
 *
 * Also stores the last outgoing reply per convKey for continuity context.
 */
object ContactMemory {

    private const val MAX_ENTRIES  = 30
    private const val MAX_AGE_DAYS = 90
    private const val MIN_KEEP     = 10

    // ── Public read API ───────────────────────────────────────────────────────

    /**
     * Resolves the best storage key for this conversation: contactId if confirmed,
     * otherwise falls back to convKey. Returns a formatted multi-line block ready
     * to inject into the worker prompt, or null if no memory exists.
     */
    fun buildMemoryBlock(context: Context, convKey: String): String? {
        val key = resolveKey(context, convKey)
        val obj = load(context, key) ?: return null
        val summary = obj.optString("summary").ifEmpty { null }
        val entries = obj.optJSONArray("entries")

        val lines = mutableListOf<String>()
        if (entries != null && entries.length() > 0) {
            val fmt = SimpleDateFormat("d MMM", Locale.getDefault())
            for (i in 0 until entries.length()) {
                val e = entries.optJSONObject(i) ?: continue
                val ts   = e.optLong("ts", 0L)
                val text = e.optString("text").ifEmpty { null } ?: continue
                val date = if (ts > 0) fmt.format(Date(ts)) else null
                lines.add(if (date != null) "[$date] $text" else text)
            }
        }

        return when {
            lines.isNotEmpty() -> {
                val header = "Past context about this contact (most recent first):"
                (listOf(header) + lines.asReversed()).joinToString("\n")
            }
            summary != null -> "Past context about this contact: $summary"
            else -> null
        }
    }

    fun getLastSent(context: Context, convKey: String): String? =
        prefs(context).getString(sentKey(convKey), null)

    // ── Public write API ──────────────────────────────────────────────────────

    /**
     * Saves the worker's contextUpdate as the rolling summary and appends any
     * high-intent snippets to the entries list. Keyed by contactId where available.
     */
    fun save(
        context: Context,
        convKey: String,
        contextUpdate: String?,
        snippets: List<String> = emptyList(),
    ) {
        if (contextUpdate == null && snippets.isEmpty()) return
        val key = resolveKey(context, convKey)
        val obj = load(context, key) ?: JSONObject()

        if (contextUpdate != null) obj.put("summary", contextUpdate)

        if (snippets.isNotEmpty()) {
            val entries = obj.optJSONArray("entries") ?: JSONArray()
            val now = System.currentTimeMillis()
            for (text in snippets) {
                if (text.isBlank()) continue
                entries.put(JSONObject().apply {
                    put("ts", now)
                    put("text", text.trim())
                })
            }
            obj.put("entries", prune(entries))
        }

        prefs(context).edit().putString(memKey(key), obj.toString()).apply()
    }

    fun saveLastSent(context: Context, convKey: String, replyText: String) {
        prefs(context).edit().putString(sentKey(convKey), replyText).apply()
    }

    fun clearLastSent(context: Context, convKey: String) {
        prefs(context).edit().remove(sentKey(convKey)).apply()
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Returns the contactId if this convKey has been confirmed, else the convKey itself. */
    fun resolveKey(context: Context, convKey: String): String {
        return try {
            val confirmed = JSONObject(
                Prefs.main(context).getString("confirmed_identities", "{}") ?: "{}"
            )
            confirmed.optString(convKey).ifEmpty { null } ?: convKey
        } catch (_: Exception) { convKey }
    }

    private fun load(context: Context, key: String): JSONObject? {
        val raw = prefs(context).getString(memKey(key), null) ?: return null
        return try {
            val obj = JSONObject(raw)
            // Migrate legacy plain-string entries written before this schema
            if (!obj.has("summary") && !obj.has("entries")) null else obj
        } catch (_: Exception) { null }
    }

    private fun prune(entries: JSONArray): JSONArray {
        val cutoff = System.currentTimeMillis() - MAX_AGE_DAYS * 86_400_000L
        val all = (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
        val recent = all.filter { it.optLong("ts", 0L) >= cutoff }
        val kept = when {
            recent.size >= MIN_KEEP -> recent.takeLast(MAX_ENTRIES)
            else -> all.takeLast(MAX_ENTRIES.coerceAtLeast(MIN_KEEP))
        }
        return JSONArray().also { arr -> kept.forEach { arr.put(it) } }
    }

    private fun prefs(context: Context) = Prefs.contactMemory(context)

    private fun sanitize(key: String) = key.replace(Regex("[^a-zA-Z0-9_:.-]"), "_").take(200)
    private fun memKey(key: String)  = "mem_${sanitize(key)}"
    private fun sentKey(convKey: String) = "sent_${sanitize(convKey)}"
}
