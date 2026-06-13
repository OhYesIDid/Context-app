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
            val raw = context.getSharedPreferences(QUEUE_PREFS, Context.MODE_PRIVATE)
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

        context.getSharedPreferences(MAIN_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(NATIVE_KEY, edits.joinToString("\n"))
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(MAIN_PREFS, Context.MODE_PRIVATE)
            .edit().remove(NATIVE_KEY).apply()
    }
}
