package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// Persists an unresolved contact-match suggestion so it survives past a single bubble
// dismissal. Previously ContactLinking.decideContactMatch() re-evaluated fresh on every
// message with no queue anywhere — declining a same-app name-match banner with no
// alternatives just hid it (nothing written to confirmed_identities), so the exact same
// banner reappeared on the sender's next message with no record it had been shown before.
//
// Written/cleared by ProTxtBgService.contactMatchJson() every time it poses or resolves a
// banner decision for a convKey. Read by ContactsScreen's "Suggested links" section via
// ProTxtSettingsModule's getPendingContactLinks bridge method.
object ContactLinkStore {
    private const val KEY = "pending_contact_links"

    // decisionJson is ContactLinking.ContactMatchDecision.json verbatim (contactId,
    // displayName, preferredTone, confidence, candidates[], optional crossApp fields) —
    // stored as-is plus the fields the RN side needs that aren't already in it.
    fun upsert(context: Context, convKey: String, senderName: String, platform: String?, decisionJson: String) {
        val prefs = Prefs.main(context)
        try {
            val entry = JSONObject(decisionJson).apply {
                put("convKey", convKey)
                put("senderName", senderName)
                put("platform", platform ?: JSONObject.NULL)
                put("updatedAt", System.currentTimeMillis())
            }
            val existing = JSONArray(prefs.getString(KEY, "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until existing.length()) {
                val item = existing.optJSONObject(i) ?: continue
                if (item.optString("convKey") != convKey) next.put(item)
            }
            next.put(entry)
            prefs.edit().putString(KEY, next.toString()).apply()
        } catch (_: Exception) {}
    }

    fun clear(context: Context, convKey: String) {
        val prefs = Prefs.main(context)
        try {
            val existing = JSONArray(prefs.getString(KEY, "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until existing.length()) {
                val item = existing.optJSONObject(i) ?: continue
                if (item.optString("convKey") != convKey) next.put(item)
            }
            prefs.edit().putString(KEY, next.toString()).apply()
        } catch (_: Exception) {}
    }

    fun getAll(context: Context): String = Prefs.main(context).getString(KEY, "[]") ?: "[]"
}
