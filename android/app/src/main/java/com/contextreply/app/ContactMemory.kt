package com.contextreply.app

import android.content.Context

/**
 * Persists a short worker-generated summary per contact across sessions.
 * The worker returns a `contextUpdate` string after each suggestion; we store
 * it here and send it back on the next request for the same contact.
 *
 * Format (one string per contact, ~20 words):
 *   "Planning birthday party Sat 14th; asked about venue twice"
 *
 * Also stores the last outgoing reply so the worker knows what was said.
 */
object ContactMemory {

    private const val PREFS = "contextreply_contact_memory"

    fun getMemory(context: Context, convKey: String): String? =
        prefs(context).getString(memKey(convKey), null)

    fun saveMemory(context: Context, convKey: String, contextUpdate: String) {
        prefs(context).edit().putString(memKey(convKey), contextUpdate).apply()
    }

    fun getLastSent(context: Context, convKey: String): String? =
        prefs(context).getString(sentKey(convKey), null)

    fun saveLastSent(context: Context, convKey: String, replyText: String) {
        prefs(context).edit().putString(sentKey(convKey), replyText).apply()
    }

    fun clearLastSent(context: Context, convKey: String) {
        prefs(context).edit().remove(sentKey(convKey)).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun sanitize(convKey: String) = convKey.replace(Regex("[^a-zA-Z0-9_:.-]"), "_").take(200)
    private fun memKey(convKey: String) = "mem_${sanitize(convKey)}"
    private fun sentKey(convKey: String) = "sent_${sanitize(convKey)}"
}
