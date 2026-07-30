package com.contextreply.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

// closenessScore()/computeInsights() are internal specifically so they're testable
// without a Context — see build.gradle's stub-android.jar setup, same rationale as
// ContactMatcherTest.
class ContactSignalsTest {

    private val DAY = 86_400_000L
    private val NOW = 100_000_000_000L
    private lateinit var originalTimeZone: TimeZone

    // computeInsights()'s mostActiveHour uses Calendar.getInstance() (JVM default zone)
    // — pin it to UTC for the duration of this class so hour-of-day assertions are
    // deterministic regardless of the machine running the test.
    @Before fun fixTimeZone() {
        originalTimeZone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restoreTimeZone() {
        TimeZone.setDefault(originalTimeZone)
    }

    // Builds a "ts"/"delays" blob matching recordIncoming/recordReply's real shape.
    // Timestamps are oldest-first, most-recent-last — the same order the real ts
    // array ends up in, since recordIncoming appends each new arrival to the end.
    private fun sigObj(timestamps: List<Long>, delays: List<Int>? = null): JSONObject {
        val obj = JSONObject()
        obj.put("ts", JSONArray(timestamps))
        if (delays != null) obj.put("delays", JSONArray(delays))
        return obj
    }

    // Epoch millis for a specific UTC hour-of-day, on 1+dayOffset Jan 2026 — arbitrary
    // fixed reference dates, only the hour-of-day and relative spacing matter.
    private fun epochAtHour(hour: Int, dayOffset: Int = 0): Long {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.set(2026, Calendar.JANUARY, 1 + dayOffset, hour, 0, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    @Test fun `returns null when there is no timestamp data`() {
        assertNull(ContactSignals.closenessScore(JSONObject(), NOW))
    }

    @Test fun `recency component at exactly the 14-day half-life combines with zero frequency`() {
        // 14 days old and outside the 7-day frequency window -> recency=0.5, frequency=0,
        // no reciprocity data -> 0.5*0.5 + 0*0.5 = 0.25.
        val obj = sigObj(listOf(NOW - 14 * DAY))
        assertEquals(0.25, ContactSignals.closenessScore(obj, NOW)!!, 0.01)
    }

    @Test fun `a message just now scores well above the halfway point`() {
        val obj = sigObj(listOf(NOW))
        // recency=1.0, frequency=1/20=0.05 -> 0.525
        assertTrue(ContactSignals.closenessScore(obj, NOW)!! > 0.5)
    }

    @Test fun `frequency is capped once 7-day volume reaches the ceiling`() {
        val atCap = (20 downTo 1).map { NOW - it * 1000L }
        val overCap = (25 downTo 1).map { NOW - it * 1000L }
        val scoreAtCap = ContactSignals.closenessScore(sigObj(atCap), NOW)!!
        val scoreOverCap = ContactSignals.closenessScore(sigObj(overCap), NOW)!!
        assertEquals(scoreAtCap, scoreOverCap, 0.001)
    }

    @Test fun `fast reply speed pulls the score up relative to no reciprocity data`() {
        val ts = listOf(NOW)
        val withoutDelays = ContactSignals.closenessScore(sigObj(ts), NOW)!!
        val withFastDelays = ContactSignals.closenessScore(sigObj(ts, listOf(20, 30)), NOW)!!
        assertTrue(withFastDelays > withoutDelays)
    }

    @Test fun `slow reply speed pulls the score down relative to no reciprocity data`() {
        val ts = listOf(NOW)
        val withoutDelays = ContactSignals.closenessScore(sigObj(ts), NOW)!!
        val withSlowDelays = ContactSignals.closenessScore(sigObj(ts, listOf(90_000, 95_000)), NOW)!! // >24h avg
        assertTrue(withSlowDelays < withoutDelays)
    }

    @Test fun `a single reply sample is not enough to count as reciprocity data`() {
        val ts = listOf(NOW)
        val noDelays = ContactSignals.closenessScore(sigObj(ts), NOW)!!
        val oneDelay = ContactSignals.closenessScore(sigObj(ts, listOf(20)), NOW)!!
        assertEquals(noDelays, oneDelay, 0.001)
    }

    @Test fun `score always stays within 0 to 1 regardless of input volume`() {
        val ts = (30 downTo 1).map { NOW - it * 100L }
        val score = ContactSignals.closenessScore(sigObj(ts, listOf(10, 15, 20)), NOW)!!
        assertTrue(score in 0.0..1.0)
    }

    // ── computeInsights() ───────────────────────────────────────────────────────

    @Test fun `returns null insights when there is no timestamp data`() {
        assertNull(ContactSignals.computeInsights(JSONObject(), NOW))
    }

    @Test fun `counts messages in the last 7 days separately from the prior 7 days`() {
        val recent = listOf(NOW - 1 * DAY, NOW - 2 * DAY)
        val prior = listOf(NOW - 10 * DAY)
        val insights = ContactSignals.computeInsights(sigObj(recent + prior), NOW)!!
        assertEquals(2, insights.getInt("msgsLast7d"))
        assertEquals(1, insights.getInt("msgsPrior7d"))
    }

    @Test fun `average reply time only appears once there are at least two samples`() {
        val ts = listOf(NOW)
        val noDelays = ContactSignals.computeInsights(sigObj(ts), NOW)!!
        assertFalse(noDelays.has("avgReplySecs"))

        val withDelays = ContactSignals.computeInsights(sigObj(ts, listOf(60, 120)), NOW)!!
        assertEquals(90, withDelays.getInt("avgReplySecs"))
    }

    @Test fun `most active hour is omitted below the 5-sample threshold`() {
        val ts = (1..4).map { epochAtHour(14) - it * 1000L } // 4 samples, all near 14:00
        val insights = ContactSignals.computeInsights(sigObj(ts), NOW)!!
        assertFalse(insights.has("mostActiveHour"))
    }

    @Test fun `most active hour picks the hour with the most timestamps`() {
        val fourteens = (0 until 4).map { epochAtHour(14, dayOffset = it) }
        val nines = (0 until 2).map { epochAtHour(9, dayOffset = it) }
        val insights = ContactSignals.computeInsights(sigObj(fourteens + nines), NOW)!!
        assertEquals(14, insights.getInt("mostActiveHour"))
    }
}
