package com.contextreply.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

// Pure request/response building — no Context, no network. See CalendarWriteHelper's own
// doc comment and the research-evolving-plans-memory memory for why this exists.
class CalendarWriteHelperTest {

    @Test fun `event body carries title, start, and end derived from duration`() {
        val start = LocalDateTime.of(2026, 8, 1, 8, 0, 0)
        val body = CalendarWriteHelper.buildEventBody("Ride with Stew", start, 90, "plan-1")

        assertEquals("Ride with Stew", body.getString("summary"))
        assertTrue(body.getJSONObject("start").getString("dateTime").startsWith("2026-08-01T08:00"))
        assertTrue(body.getJSONObject("end").getString("dateTime").startsWith("2026-08-01T09:30"))
    }

    @Test fun `planId is stored as a private extended property`() {
        val body = CalendarWriteHelper.buildEventBody("Ride", LocalDateTime.of(2026, 8, 1, 8, 0), 60, "plan-42")
        val planId = body.getJSONObject("extendedProperties").getJSONObject("private").getString("contxtPlanId")
        assertEquals("plan-42", planId)
    }

    @Test fun `start and end datetimes include a UTC offset, not a bare local time`() {
        // Google's Calendar API expects RFC3339 with an offset (or an explicit timeZone field);
        // a bare "2026-08-01T08:00:00" with neither is ambiguous.
        val body = CalendarWriteHelper.buildEventBody("Ride", LocalDateTime.of(2026, 8, 1, 8, 0), 60, "plan-1")
        val startDt = body.getJSONObject("start").getString("dateTime")
        assertTrue("expected an offset suffix in '$startDt'", Regex("""(Z|[+-]\d{2}:\d{2})$""").containsMatchIn(startDt))
    }

    @Test fun `eventUrl targets the insert endpoint when no event id is known`() {
        assertEquals(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            CalendarWriteHelper.eventUrl(null),
        )
    }

    @Test fun `eventUrl targets the specific event when an id is already known`() {
        assertEquals(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events/abc123",
            CalendarWriteHelper.eventUrl("abc123"),
        )
    }

    @Test fun `extracts the event id from a successful API response`() {
        assertEquals("evt-1", CalendarWriteHelper.extractEventId("""{"id":"evt-1","summary":"Ride"}"""))
    }

    @Test fun `returns null for a response with no id`() {
        assertNull(CalendarWriteHelper.extractEventId("""{"summary":"Ride"}"""))
    }

    @Test fun `returns null instead of throwing on malformed response bodies`() {
        assertNull(CalendarWriteHelper.extractEventId("not json"))
    }
}
