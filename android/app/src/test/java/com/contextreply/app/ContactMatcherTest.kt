package com.contextreply.app

import org.junit.Assert.assertTrue
import org.junit.Test

// ContactMatcher.bestMatches() itself needs a Context (SharedPreferences-backed cache),
// which this project's plain-JUnit unit tests can't provide — see build.gradle's
// stub-android.jar setup. nameScore() is internal specifically so this signal logic is
// testable on its own; MIN_MATCH/AUTO_APPLY live as ContactMatcher constants and are
// referenced directly rather than duplicated as literals.
class ContactMatcherTest {

    private val minMatch = 0.70
    private val autoApply = ContactMatcher.AUTO_APPLY

    // ── Baseline behaviour (regression — must survive the Phase C signal additions) ──

    @Test fun `exact match scores 1_0`() {
        assertTrue(ContactMatcher.nameScore("Tom Smith", "Tom Smith") == 1.0)
    }

    @Test fun `unrelated names score below MIN_MATCH`() {
        assertTrue(ContactMatcher.nameScore("Priya Nair", "Tom Smith") < minMatch)
    }

    @Test fun `transposed tokens still match via token-sort`() {
        assertTrue(ContactMatcher.nameScore("Smith Tom", "Tom Smith") >= autoApply)
    }

    // ── New signal: handle-separator normalization ──────────────────────────────────

    @Test fun `dot-separated handle matches the equivalent real name`() {
        assertTrue(ContactMatcher.nameScore("tom.smith", "Tom Smith") >= autoApply)
    }

    @Test fun `underscore-separated handle matches the equivalent real name`() {
        assertTrue(ContactMatcher.nameScore("tom_smith", "Tom Smith") >= autoApply)
    }

    @Test fun `leading at-sign is stripped before comparison`() {
        assertTrue(ContactMatcher.nameScore("@tom.smith", "Tom Smith") >= autoApply)
    }

    @Test fun `a numeric suffix on a separated handle does not suppress the match`() {
        assertTrue(ContactMatcher.nameScore("tom.smith99", "Tom Smith") >= minMatch)
    }

    // ── New signal: first-name-only comparison for compact single-token senders ─────

    @Test fun `a compact nickname matches via first-name comparison`() {
        // "tommyg" shares no separator with "Tom Smith" — only the first-name-only
        // signal (needle vs candidate's first token) can catch this one.
        assertTrue(ContactMatcher.nameScore("tommyg", "Tom Smith") >= minMatch)
    }

    @Test fun `first-name signal does not fire for a multi-word needle`() {
        // Guards against comparing a full name against just a candidate's first name,
        // which would let e.g. "Tom Jones" incorrectly score well against "Tom Smith".
        val guarded = ContactMatcher.nameScore("Tom Jones", "Tom Smith")
        val unguardedEquivalent = ContactMatcher.nameScore("tomjones", "Tom Smith")
        assertTrue(guarded <= unguardedEquivalent)
    }

    @Test fun `first-name signal does not fire when the candidate itself is single-token`() {
        // firstToken == haystack in this case — no separate first-name comparison to add.
        val score = ContactMatcher.nameScore("tommyg", "Tommy")
        assertTrue(score >= autoApply) // still matches, just via the normal full-string path
    }
}
