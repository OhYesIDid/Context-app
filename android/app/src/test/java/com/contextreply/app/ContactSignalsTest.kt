package com.contextreply.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// closenessScore() is internal specifically so this is testable without a Context —
// see build.gradle's stub-android.jar setup, same rationale as ContactMatcherTest.
class ContactSignalsTest {

    private val DAY = 86_400_000L
    private val NOW = 100_000_000_000L

    // Builds a "ts"/"delays" blob matching recordIncoming/recordReply's real shape.
    // Timestamps are oldest-first, most-recent-last — the same order the real ts
    // array ends up in, since recordIncoming appends each new arrival to the end.
    private fun sigObj(timestamps: List<Long>, delays: List<Int>? = null): JSONObject {
        val obj = JSONObject()
        obj.put("ts", JSONArray(timestamps))
        if (delays != null) obj.put("delays", JSONArray(delays))
        return obj
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
}
