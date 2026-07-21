package com.contextreply.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

// Plain JUnit4, no Robolectric/instrumentation — every function under test is pure.
// Intent-detection test fixtures use small representative regexes rather than the real
// assets/intent_patterns.json (already thoroughly covered by src/utils/__tests__/intentDetector.test.ts,
// which reads the same shared file); these tests validate the matching/priority/fallback
// ALGORITHM, not the production pattern content.
class IntentAndSignalsTest {

    private val fixturePatterns: Map<String, List<Regex>> = mapOf(
        "eta" to listOf(Regex("""\bhow long\b""", RegexOption.IGNORE_CASE)),
        "availability" to listOf(Regex("""\bfree\b""", RegexOption.IGNORE_CASE)),
        "booking" to listOf(Regex("""\bhotel\b""", RegexOption.IGNORE_CASE)),
        "location_share" to listOf(Regex("""\bwhere are you\b""", RegexOption.IGNORE_CASE)),
        "incoming_location" to listOf(Regex("""maps\.google\.com""")),
        "general" to listOf(Regex("""\bbirthday\b""", RegexOption.IGNORE_CASE)),
    )

    // ── computeDebounceMs ────────────────────────────────────────────────────────

    @Test fun `debounce is fast for a finished-sounding message`() {
        assertEquals(1_200L, IntentAndSignals.computeDebounceMs("On my way!"))
        assertEquals(1_200L, IntentAndSignals.computeDebounceMs("Are you free?"))
        assertEquals(1_200L, IntentAndSignals.computeDebounceMs("Done."))
    }

    @Test fun `debounce is slow for a trailing comma or continuation word`() {
        assertEquals(4_000L, IntentAndSignals.computeDebounceMs("wait, so"))
        assertEquals(4_000L, IntentAndSignals.computeDebounceMs("I was going to say wait"))
        assertEquals(4_000L, IntentAndSignals.computeDebounceMs("because"))
    }

    @Test fun `debounce falls back to the default for anything else`() {
        assertEquals(2_500L, IntentAndSignals.computeDebounceMs("sounds good"))
        assertEquals(2_500L, IntentAndSignals.computeDebounceMs(""))
        assertEquals(2_500L, IntentAndSignals.computeDebounceMs("   "))
    }

    // ── stripAppPrefix / packageToPlatform / appLabel ────────────────────────────

    @Test fun `stripAppPrefix removes a single-word app prefix but not a multi-word group name`() {
        assertEquals("Maya Hinge", IntentAndSignals.stripAppPrefix("WhatsApp: Maya Hinge"))
        assertEquals("Ski - Val d'isere", IntentAndSignals.stripAppPrefix("Ski - Val d'isere"))
        assertEquals("no colon here", IntentAndSignals.stripAppPrefix("no colon here"))
    }

    @Test fun `packageToPlatform and appLabel map known packages`() {
        assertEquals("whatsapp", IntentAndSignals.packageToPlatform("com.whatsapp"))
        assertNull(IntentAndSignals.packageToPlatform("com.example.unknown"))
        assertEquals("WhatsApp", IntentAndSignals.appLabel("com.whatsapp"))
        assertEquals("Unknown", IntentAndSignals.appLabel("com.example.unknown"))
    }

    // ── detectIntents ────────────────────────────────────────────────────────────

    @Test fun `detects a specific intent over the general fallback`() {
        assertEquals(listOf("eta"), IntentAndSignals.detectIntents(fixturePatterns, "how long until you're here"))
    }

    @Test fun `falls back to general only when nothing more specific matched`() {
        assertEquals(listOf("general"), IntentAndSignals.detectIntents(fixturePatterns, "happy birthday!"))
    }

    @Test fun `does not report general alongside a specific intent`() {
        val intents = IntentAndSignals.detectIntents(fixturePatterns, "are you free later, it's my birthday")
        assertTrue(intents.contains("availability"))
        assertFalse(intents.contains("general"))
    }

    @Test fun `falls back to other when nothing matches at all`() {
        assertEquals(listOf("other"), IntentAndSignals.detectIntents(fixturePatterns, "lol nice"))
    }

    @Test fun `isEtaIntent mirrors the eta pattern check`() {
        assertTrue(IntentAndSignals.isEtaIntent(fixturePatterns, "how long till you arrive"))
        assertFalse(IntentAndSignals.isEtaIntent(fixturePatterns, "are you free"))
    }

    // ── requiredEnrichments ──────────────────────────────────────────────────────

    @Test fun `maps required enrichments from resolved intents string, deduping`() {
        val result = IntentAndSignals.requiredEnrichments(fixturePatterns, "ignored", "eta,general")
        assertEquals(listOf("maps", "calendar"), result)
    }

    @Test fun `falls back to detecting intents from the message when none are pre-resolved`() {
        val result = IntentAndSignals.requiredEnrichments(fixturePatterns, "how long till you're here")
        assertEquals(listOf("maps"), result)
    }

    // ── computeUrgencyScore ──────────────────────────────────────────────────────

    @Test fun `urgency score clamps at 3 even when every signal fires`() {
        val score = IntentAndSignals.computeUrgencyScore("asap!! are you there?? how long", "eta", burstSize = 5)
        assertEquals(3, score)
    }

    @Test fun `urgency score is 0 for a calm, single, unrelated message`() {
        assertEquals(0, IntentAndSignals.computeUrgencyScore("sounds good, see you then", "other", burstSize = 0))
    }

    @Test fun `burst size of 2 or more contributes to the score`() {
        val withBurst = IntentAndSignals.computeUrgencyScore("ok", "other", burstSize = 2)
        val withoutBurst = IntentAndSignals.computeUrgencyScore("ok", "other", burstSize = 1)
        assertEquals(withoutBurst + 1, withBurst)
    }

    // ── extractMapsCoordinates / extractShortMapsUrl ─────────────────────────────

    @Test fun `extracts coordinates from a full Google Maps URL`() {
        val result = IntentAndSignals.extractMapsCoordinates("https://maps.google.com/maps/place/X/@51.50735,-0.12776,15z")
        assertEquals(51.50735, result!!.first, 0.00001)
        assertEquals(-0.12776, result.second, 0.00001)
    }

    @Test fun `rejects out-of-range coordinates`() {
        assertNull(IntentAndSignals.extractMapsCoordinates("@200.0,-500.0"))
    }

    @Test fun `returns null when no coordinates are present`() {
        assertNull(IntentAndSignals.extractMapsCoordinates("just a normal message"))
    }

    @Test fun `extracts a maps short URL`() {
        assertEquals("https://maps.app.goo.gl/abc123", IntentAndSignals.extractShortMapsUrl("here: https://maps.app.goo.gl/abc123"))
        assertNull(IntentAndSignals.extractShortMapsUrl("no link here"))
    }

    // ── detectEmotionalCharge ────────────────────────────────────────────────────

    @Test fun `detects high-confidence anger from repeated exclamation marks`() {
        val result = IntentAndSignals.detectEmotionalCharge("this is unacceptable!!", emptyList())
        assertEquals("anger", result!!.getString("emotion"))
        assertEquals("high", result.getString("confidence"))
    }

    @Test fun `low-confidence signals only fire on short messages`() {
        val short = IntentAndSignals.detectEmotionalCharge("whatever", emptyList())
        assertEquals("passive_agg", short!!.getString("emotion"))
        assertEquals("low", short.getString("confidence"))

        val longVersion = "whatever, I guess that is just how things are going to be from now on then"
        assertNull(IntentAndSignals.detectEmotionalCharge(longVersion, emptyList()))
    }

    @Test fun `returns null when nothing emotionally charged is detected`() {
        assertNull(IntentAndSignals.detectEmotionalCharge("sounds good, see you at 6", emptyList()))
    }

    // ── extractEventKeyword / extractSearchTerm ──────────────────────────────────

    @Test fun `extracts the event keyword from a when-is question`() {
        assertEquals("doodie's birthday", IntentAndSignals.extractEventKeyword("when is doodie's birthday?"))
    }

    @Test fun `search term strips leading stopwords and possessive suffix`() {
        assertEquals("birthday", IntentAndSignals.extractSearchTerm("the birthday"))
        assertEquals("party", IntentAndSignals.extractSearchTerm("her party"))
        assertEquals("doodie", IntentAndSignals.extractSearchTerm("doodie's birthday"))
    }

    // ── extractDestination ───────────────────────────────────────────────────────

    @Test fun `extracts a destination from a how-far-from question`() {
        assertEquals("the office", IntentAndSignals.extractDestination("how far are you from the office?"))
    }

    @Test fun `extracts a destination after a preposition like near`() {
        assertEquals("the station", IntentAndSignals.extractDestination("are you near the station?"))
    }

    @Test fun `strips a leading time-of-day mention that would otherwise be captured`() {
        // Regression case from the source comment: the first "at" in the sentence (before the
        // time) matches, not the one right before the actual place — the time prefix is
        // stripped back off so the Directions API isn't handed "9pm at McDonald's".
        assertEquals("McDonald's", IntentAndSignals.extractDestination("meeting at 9pm at McDonald's"))
    }

    @Test fun `rejects noise words that are not real destinations`() {
        assertNull(IntentAndSignals.extractDestination("are you near here?"))
    }

    @Test fun `rejects captures that read like a sentence fragment`() {
        assertNull(IntentAndSignals.extractDestination("far from I will get there"))
    }

    @Test fun `returns null when no destination pattern matches`() {
        assertNull(IntentAndSignals.extractDestination("just chatting, nothing planned"))
    }

    // ── isPastTemporalQuery ──────────────────────────────────────────────────────

    @Test fun `identifies past-tense temporal questions`() {
        assertTrue(IntentAndSignals.isPastTemporalQuery("how was the concert last Friday"))
        assertTrue(IntentAndSignals.isPastTemporalQuery("did you make it home ok"))
        assertFalse(IntentAndSignals.isPastTemporalQuery("are you free next week"))
    }

    // ── extractMentionedDate ─────────────────────────────────────────────────────

    @Test fun `resolves a mentioned date within the current year when it has not passed yet`() {
        val today = LocalDate.of(2026, 6, 1)
        val result = IntentAndSignals.extractMentionedDate("let's do 30th July", today)
        val expected = LocalDate.of(2026, 7, 30).atStartOfDay(ZoneOffset.UTC).toInstant()
        assertEquals(expected, result)
    }

    @Test fun `rolls over to next year when the mentioned date has already passed`() {
        val today = LocalDate.of(2026, 8, 15)
        val result = IntentAndSignals.extractMentionedDate("it was on July 30", today)
        val expected = LocalDate.of(2027, 7, 30).atStartOfDay(ZoneOffset.UTC).toInstant()
        assertEquals(expected, result)
    }

    @Test fun `returns null when no specific date is mentioned`() {
        val today = LocalDate.of(2026, 6, 1)
        assertNull(IntentAndSignals.extractMentionedDate("are you free this weekend", today))
    }
}
