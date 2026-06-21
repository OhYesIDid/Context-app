package com.contextreply.app

import android.content.Context
import org.json.JSONArray

/**
 * Reads the StyleEditQueue SharedPrefs directly (no JS bridge) and maintains a compact
 * "native_recent_edits" entry in contextreply_prefs. WorkerClient appends this to the
 * cached style profile so suggestions immediately reflect the latest edits even when the
 * main app hasn't been opened since the last send.
 *
 * The full JS-side syncStyleProfile() (with recency decay, grouping, etc.) still runs
 * on app foreground and overwrites the cached profile. This is the lightweight fast path.
 */
object NativeStyleSync {

    private const val QUEUE_PREFS  = "contextreply_style_queue"
    private const val QUEUE_KEY    = "queue"
    private const val MAIN_PREFS   = "contextreply_prefs"
    private const val NATIVE_KEY   = "native_recent_edits"
    private const val MAX_EDITS    = 5

    fun syncFromQueue(context: Context) {
        val arr = try {
            val raw = Prefs.styleQueue(context)
                .getString(QUEUE_KEY, "[]") ?: "[]"
            JSONArray(raw)
        } catch (_: Exception) { return }

        if (arr.length() == 0) return

        val edits = mutableListOf<String>()
        // Walk backwards (newest first), collect up to MAX_EDITS meaningful edits
        for (i in (arr.length() - 1) downTo 0) {
            if (edits.size >= MAX_EDITS) break
            val item = arr.optJSONObject(i) ?: continue
            val original = item.optString("original").trim()
            val edit     = item.optString("edit").trim()
            if (edit.isEmpty() || edit.equals(original, ignoreCase = true)) continue
            edits.add("• \"$original\" → \"$edit\"")
        }

        if (edits.isEmpty()) return

        Prefs.main(context)
            .edit()
            .putString(NATIVE_KEY, edits.joinToString("\n"))
            .apply()

        // Rebuild the full style profile from the complete queue
        StyleProfileBuilder.rebuild(context)
    }

    fun clear(context: Context) {
        Prefs.main(context)
            .edit().remove(NATIVE_KEY).apply()
    }
}
