package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// Single source of truth for the pending_follow_ups / confirmed_follow_ups SharedPrefs lists —
// shared by ProTxtBgService (in-process), ProTxtSettingsModule (JS bridge), and
// FollowUpActionReceiver (notification action taps, which may run with no service instance
// alive — a plain Context-taking object avoids the null-instance problem entirely). Centralizing
// this also fixed the duplicate-follow-up bug: confirm() used to be a raw JSONArray.put() append
// with no id check in ProTxtBgService, so a fast double-tap on the bubble's confirm button (or
// any other future caller) could append the same task twice into confirmed_follow_ups, and JS's
// addFollowUp() had nothing stopping it from creating two entries for what the array delivered
// as two "confirmations". Every write path here is upsert-by-id, matching the pattern the
// pending-side upsert already used correctly.
object FollowUpStore {
    private const val PENDING_KEY = "pending_follow_ups"
    private const val CONFIRMED_KEY = "confirmed_follow_ups"

    fun getPending(context: Context, id: String): JSONObject? {
        val arr = JSONArray(Prefs.main(context).getString(PENDING_KEY, "[]") ?: "[]")
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("id") == id) return item
        }
        return null
    }

    // Upserts a follow-up task into the pending list, then schedules the confirm-reminder
    // notification (FollowUpReminderWorker) — re-proposing the same id (same convKey+task)
    // just resets that job's delay window rather than stacking a second one, since scheduling
    // uses ExistingWorkPolicy.REPLACE.
    fun upsertPending(context: Context, id: String, task: String, dueHint: String?, dueAt: String?, contactName: String, convKey: String) {
        val prefs = Prefs.main(context)
        try {
            val existing = JSONArray(prefs.getString(PENDING_KEY, "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until existing.length()) {
                val item = existing.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            next.put(JSONObject().apply {
                put("id", id)
                put("task", task)
                put("dueHint", dueHint?.ifEmpty { null } ?: JSONObject.NULL)
                put("dueAt", dueAt?.ifEmpty { null } ?: JSONObject.NULL)
                put("contactName", contactName.ifEmpty { null } ?: JSONObject.NULL)
                put("convKey", convKey)
                put("createdAt", System.currentTimeMillis())
            })
            prefs.edit().putString(PENDING_KEY, next.toString()).apply()
        } catch (_: Exception) {}
        FollowUpReminderWorker.schedule(context, id)
    }

    // Removes a pending follow-up by id and cancels its scheduled reminder — called on explicit
    // dismiss (HomeScreen, bubble, or the notification's own Dismiss action), and from confirm()
    // below (a confirmed task doesn't need a "did you mean to confirm this?" nudge afterward).
    fun dismiss(context: Context, id: String) {
        val prefs = Prefs.main(context)
        try {
            val arr = JSONArray(prefs.getString(PENDING_KEY, "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            prefs.edit().putString(PENDING_KEY, next.toString()).apply()
        } catch (_: Exception) {}
        FollowUpReminderWorker.cancel(context, id)
    }

    // Moves a task from pending to confirmed so JS can drain it into AsyncStorage. Upserts
    // confirmed_follow_ups by id rather than a raw append — see the file-level comment above.
    fun confirm(context: Context, id: String, task: String, contactName: String, dueHint: String?, dueAt: String?) {
        val prefs = Prefs.main(context)
        dismiss(context, id)
        try {
            val existing = JSONArray(prefs.getString(CONFIRMED_KEY, "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until existing.length()) {
                val item = existing.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            next.put(JSONObject().apply {
                put("id", id)
                put("task", task)
                put("contactName", contactName.ifEmpty { null } ?: JSONObject.NULL)
                put("dueHint", dueHint?.ifEmpty { null } ?: JSONObject.NULL)
                put("dueAt", dueAt?.ifEmpty { null } ?: JSONObject.NULL)
                put("createdAt", System.currentTimeMillis())
            })
            prefs.edit().putString(CONFIRMED_KEY, next.toString()).apply()
        } catch (_: Exception) {}
    }
}
