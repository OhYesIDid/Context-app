package com.contextreply.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationGatingTest {

    // ── isNoReplyText ────────────────────────────────────────────────────────────

    @Test fun `filters a missed call notification`() {
        assertTrue(NotificationGating.isNoReplyText(title = "Alice", text = "Missed voice call"))
    }

    @Test fun `filters a reaction notification`() {
        assertTrue(NotificationGating.isNoReplyText(title = "Alice", text = "Alice reacted ❤️ to your message"))
    }

    @Test fun `filters a follow-request notification`() {
        assertTrue(NotificationGating.isNoReplyText(title = "Instagram", text = "Bob started following you"))
    }

    @Test fun `filters a group-message-count summary`() {
        assertTrue(NotificationGating.isNoReplyText(title = "WhatsApp", text = "3 new messages"))
    }

    @Test fun `filters a promo notification`() {
        assertTrue(NotificationGating.isNoReplyText(title = "Deals", text = "Limited time offer just for you"))
    }

    @Test fun `does not filter a normal DM`() {
        assertFalse(NotificationGating.isNoReplyText(title = "Alice", text = "Hey, are you free later?"))
    }

    // ── isInstagramNonDmTitle ─────────────────────────────────────────────────────

    @Test fun `flags a bare Instagram title as non-DM`() {
        assertTrue(NotificationGating.isInstagramNonDmTitle("Instagram"))
    }

    @Test fun `flags an activity digest title as non-DM`() {
        assertTrue(NotificationGating.isInstagramNonDmTitle("Your post is getting attention"))
    }

    @Test fun `does not flag a real DM sender's name`() {
        assertFalse(NotificationGating.isInstagramNonDmTitle("Maya Hinge"))
    }

    @Test fun `does not flag a sender name that happens to contain a matched word later`() {
        // Regression guard for the exact bug the stripAppPrefix-before-matching comment
        // describes: matching the raw (unstripped) title would let this kind of name
        // through as a false non-DM match if "Instagram" appeared anywhere in it.
        assertFalse(NotificationGating.isInstagramNonDmTitle("Instagram Fan"))
    }
}
