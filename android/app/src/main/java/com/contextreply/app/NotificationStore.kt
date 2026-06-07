package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Accumulates incoming message text per conversation in SharedPreferences.
 *
 * Each conversation is keyed by a hash of its package+sender string and stores
 * an ordered JSON array of {s: sender, t: text} objects. This gives Claude a
 * thread that grows with every notification — longer than any single EXTRA_MESSAGES
 * bundle — until the user replies, at which point it is cleared.
 */
class NotificationStore private constructor(context: Context) {

    private val prefs = context.getSharedPreferences(
        "contextreply_message_cache", Context.MODE_PRIVATE
    )

    fun isEmpty(convKey: String): Boolean =
        prefs.getString(storeKey(convKey), null) == null

    fun appendMessage(convKey: String, sender: String?, text: String) {
        val key = storeKey(convKey)
        val arr = load(key)
        arr.put(JSONObject().apply {
            put("s", sender ?: JSONObject.NULL)
            put("t", text)
        })
        // Cap at 50 messages — enough context without unbounded growth
        val start = maxOf(0, arr.length() - 50)
        if (start > 0) {
            val trimmed = JSONArray()
            for (i in start until arr.length()) trimmed.put(arr.get(i))
            save(key, trimmed)
        } else {
            save(key, arr)
        }
    }

    fun getThread(convKey: String): List<Pair<String?, String>> {
        val arr = load(storeKey(convKey))
        return (0 until arr.length()).mapNotNull { i ->
            val obj = arr.optJSONObject(i) ?: return@mapNotNull null
            val sender = if (obj.isNull("s")) null else obj.optString("s").ifEmpty { null }
            val text = obj.optString("t").ifEmpty { return@mapNotNull null }
            Pair(sender, text)
        }
    }

    fun markReplied(convKey: String) {
        prefs.edit().remove(storeKey(convKey)).apply()
    }

    private fun storeKey(convKey: String) = "conv_${convKey.hashCode()}"

    private fun load(key: String): JSONArray =
        try { JSONArray(prefs.getString(key, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }

    private fun save(key: String, arr: JSONArray) {
        prefs.edit().putString(key, arr.toString()).apply()
    }

    companion object {
        @Volatile private var instance: NotificationStore? = null

        fun getInstance(context: Context): NotificationStore =
            instance ?: synchronized(this) {
                instance ?: NotificationStore(context.applicationContext).also { instance = it }
            }
    }
}
