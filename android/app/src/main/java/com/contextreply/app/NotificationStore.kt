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

    private val appContext = context.applicationContext
    private val prefs = Prefs.messageCache(context)

    fun isEmpty(convKey: String): Boolean =
        prefs.getString(storeKey(convKey), null) == null

    @Synchronized
    fun appendMessage(convKey: String, sender: String?, text: String) {
        val key = storeKey(convKey)
        val arr = load(key)
        arr.put(JSONObject().apply {
            put("s", sender ?: JSONObject.NULL)
            put("t", text)
            put("ts", System.currentTimeMillis())
        })
        // Cap at 20 messages — enough context for a reply without excess token cost
        val start = maxOf(0, arr.length() - 20)
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

    /** Returns up to [maxCount] most-recent messages, newest-first, for ETA destination search. */
    fun getEtaSearchThread(convKey: String, maxCount: Int = 10): List<Pair<String?, String>> {
        val arr = load(storeKey(convKey))
        val result = mutableListOf<Pair<String?, String>>()
        for (i in arr.length() - 1 downTo 0) {
            if (result.size >= maxCount) break
            val obj = arr.optJSONObject(i) ?: continue
            val text = obj.optString("t")
            if (text.isEmpty()) continue
            val sender = if (obj.isNull("s")) null else obj.optString("s").ifEmpty { null }
            result.add(Pair(sender, text))
        }
        return result  // newest-first — .firstNotNullOfOrNull hits most-recent destination first
    }

    fun getUnreadMessages(convKey: String): List<Pair<String?, String>> {
        val thread = getThread(convKey)
        val start = prefs.getInt(unreadKey(convKey), 0)
        return thread.drop(start).ifEmpty { thread.takeLast(1) }
    }

    @Synchronized
    fun setUnreadStart(convKey: String, idx: Int) {
        prefs.edit().putInt(unreadKey(convKey), idx).apply()
    }

    /**
     * Migrates thread + unread + reminder state from [oldConvKey] to [newConvKey] — used
     * when a sender's notification title changes (e.g. an unknown number gets saved as a
     * contact), which otherwise silently starts a brand-new, empty conversation under the
     * new key. No-op if there's nothing stored under [oldConvKey].
     */
    @Synchronized
    fun migrate(oldConvKey: String, newConvKey: String) {
        if (oldConvKey == newConvKey) return
        val oldSk = storeKey(oldConvKey)
        val newSk = storeKey(newConvKey)
        val editor = prefs.edit()
        prefs.getString(oldSk, null)?.let { editor.putString(newSk, it) }
        val oldUnread = unreadKey(oldConvKey)
        if (prefs.contains(oldUnread)) editor.putInt(unreadKey(newConvKey), prefs.getInt(oldUnread, 0))
        val oldUrgencyKey = "reminder_urgency_$oldSk"
        val oldFiredKey = "reminder_fired_$oldSk"
        if (prefs.contains(oldUrgencyKey)) editor.putInt("reminder_urgency_$newSk", prefs.getInt(oldUrgencyKey, 0))
        if (prefs.contains(oldFiredKey)) editor.putBoolean("reminder_fired_$newSk", prefs.getBoolean(oldFiredKey, false))
        editor.remove(oldSk).remove(oldUnread).remove(oldUrgencyKey).remove(oldFiredKey).apply()
        // Cancel the old key's scheduled reminder — the caller reschedules under the new
        // key as part of the normal per-message flow, using the migrated urgency above.
        ReminderWorker.cancel(appContext, oldConvKey)
    }

    fun markReplied(convKey: String) {
        val sk = storeKey(convKey)
        prefs.edit()
            .remove(sk)
            .remove(unreadKey(convKey))
            .remove("reminder_urgency_$sk")
            .remove("reminder_fired_$sk")
            .apply()
        ReminderWorker.cancel(appContext, convKey)
    }

    fun recordPendingReminder(convKey: String, urgencyScore: Int) {
        val sk = storeKey(convKey)
        prefs.edit()
            .putInt("reminder_urgency_$sk", urgencyScore)
            .putBoolean("reminder_fired_$sk", false)
            .apply()
    }

    fun getReminderUrgency(convKey: String): Int =
        prefs.getInt("reminder_urgency_${storeKey(convKey)}", 0)

    fun markReminderFired(convKey: String) {
        prefs.edit().putBoolean("reminder_fired_${storeKey(convKey)}", true).apply()
    }

    fun hasReminderFired(convKey: String): Boolean =
        prefs.getBoolean("reminder_fired_${storeKey(convKey)}", false)

    private fun unreadKey(convKey: String) = "unread_${storeKey(convKey)}"

    private fun storeKey(convKey: String) = "conv_${convKey.replace(Regex("[^a-zA-Z0-9_:.-]"), "_").take(200)}"

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
