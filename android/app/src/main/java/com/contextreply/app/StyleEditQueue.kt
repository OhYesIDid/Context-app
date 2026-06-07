package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * SharedPreferences queue for (original suggestion, user-sent text) pairs.
 * Kotlin enqueues on every send. The JS style-learning layer (Sprint 3)
 * will drain this into the SQLite style_edits table via a native bridge.
 */
object StyleEditQueue {

    private const val PREFS_NAME = "contextreply_style_queue"
    private const val KEY = "queue"

    fun enqueue(
        context: Context,
        originalSuggestion: String,
        userSentText: String,
        convKey: String,
        intent: String? = null,
    ) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val arr = try {
            JSONArray(prefs.getString(KEY, "[]") ?: "[]")
        } catch (_: Exception) {
            JSONArray()
        }
        arr.put(JSONObject().apply {
            put("original", originalSuggestion)
            put("edit", userSentText)
            put("platform", platformFromConvKey(convKey))
            if (intent != null) put("intent", intent)
            put("ts", System.currentTimeMillis())
        })
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    private fun platformFromConvKey(convKey: String): String = when (convKey.substringBefore(":")) {
        "com.whatsapp", "com.whatsapp.w4b" -> "whatsapp"
        "org.telegram.messenger"            -> "telegram"
        "com.facebook.orca"                 -> "messenger"
        "com.instagram.android"             -> "instagram"
        "org.thoughtcrime.securesms"        -> "signal"
        "com.google.android.apps.messaging" -> "sms"
        else                                -> "other"
    }
}
