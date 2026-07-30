package com.contextreply.app

import android.content.Context
import org.json.JSONObject

// Persists which Google Calendar event id (if any) was created for a given plan/action id
// (see IntentAndSignals.computeActionId) — the missing piece that made calendar events
// untrackable before Phase A of the research-evolving-plans-memory memory. Not yet read
// anywhere except by ProTxtBgService.createOrPatchCalendarEvent itself (to decide insert
// vs patch on a retry for the same plan) — a future reschedule-detection feature (that
// same memo's Phase C) is the intended eventual reader.
object CalendarEventStore {
    private const val KEY = "contxt_calendar_event_ids"

    fun get(context: Context, planId: String): String? = try {
        val obj = JSONObject(Prefs.main(context).getString(KEY, "{}") ?: "{}")
        obj.optString(planId).ifEmpty { null }
    } catch (_: Exception) { null }

    fun put(context: Context, planId: String, eventId: String) {
        try {
            val prefs = Prefs.main(context)
            val obj = JSONObject(prefs.getString(KEY, "{}") ?: "{}")
            obj.put(planId, eventId)
            prefs.edit().putString(KEY, obj.toString()).apply()
        } catch (_: Exception) {}
    }
}
