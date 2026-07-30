package com.contextreply.app

import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneId

// Pure request/response building for Calendar API writes (events.insert / events.patch) —
// extracted so it's unit-testable without a Context or network. See
// ProTxtBgService.createOrPatchCalendarEvent for the actual HTTP call, and the
// research-evolving-plans-memory memory for why this exists: Phase A of that research —
// making calendar events trackable at all, the prerequisite for ever updating one
// instead of only ever creating a new one.
object CalendarWriteHelper {

    // Builds the events.insert/events.patch request body. planId is stored as a private
    // extended property — Calendar's own supported mechanism for attaching app data to
    // an event without a separate ID-mapping table — so the event stays self-identifying
    // even if local SharedPrefs state is lost (reinstall, new device).
    fun buildEventBody(title: String, start: LocalDateTime, durationMinutes: Int, planId: String): JSONObject {
        val zone = ZoneId.systemDefault()
        val startZoned = start.atZone(zone)
        val endZoned = startZoned.plusMinutes(durationMinutes.toLong())
        return JSONObject().apply {
            put("summary", title)
            put("start", JSONObject().put("dateTime", startZoned.toOffsetDateTime().toString()))
            put("end", JSONObject().put("dateTime", endZoned.toOffsetDateTime().toString()))
            put("extendedProperties", JSONObject().put("private", JSONObject().put("contxtPlanId", planId)))
        }
    }

    // Calendar API endpoint for a primary-calendar insert, or a patch of an existing event
    // when eventId is already known (a prior successful create for this same planId).
    fun eventUrl(eventId: String?): String {
        val base = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
        return if (eventId != null) "$base/$eventId" else base
    }

    fun extractEventId(responseBody: String): String? =
        try { JSONObject(responseBody).optString("id").ifEmpty { null } } catch (_: Exception) { null }
}
