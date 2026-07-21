package com.contextreply.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationPresenterTest {

    // ── contactLabel ─────────────────────────────────────────────────────────────

    @Test fun `labels a group conversation`() {
        assertEquals("Group chat", NotificationPresenter.contactLabel("com.whatsapp:group:12345"))
    }

    @Test fun `returns null for an anonymized id- prefixed convKey`() {
        assertNull(NotificationPresenter.contactLabel("com.whatsapp:id:98765"))
    }

    @Test fun `strips the app prefix from a normal sender name`() {
        assertEquals("Maya Hinge", NotificationPresenter.contactLabel("com.whatsapp:WhatsApp: Maya Hinge"))
    }

    @Test fun `truncates a long sender name to 30 characters`() {
        val longName = "A".repeat(50)
        assertEquals(longName.take(30), NotificationPresenter.contactLabel("com.whatsapp:$longName"))
    }

    // ── availableTones ───────────────────────────────────────────────────────────

    @Test fun `casual is always present at offset 0`() {
        val tones = NotificationPresenter.availableTones("casual reply", null, null)
        assertEquals(listOf(NotificationPresenter.ToneOption("Casual", "casual reply", 0)), tones)
    }

    @Test fun `includes all three tones with their fixed offsets when all are present`() {
        val tones = NotificationPresenter.availableTones("casual", "formal", "brief")
        assertEquals(
            listOf(
                NotificationPresenter.ToneOption("Casual", "casual", 0),
                NotificationPresenter.ToneOption("Formal", "formal", 3),
                NotificationPresenter.ToneOption("Brief", "brief", 4),
            ),
            tones,
        )
    }

    @Test fun `brief keeps offset 4 even when formal is absent (not derived from list position)`() {
        val tones = NotificationPresenter.availableTones("casual", null, "brief")
        assertEquals(
            listOf(
                NotificationPresenter.ToneOption("Casual", "casual", 0),
                NotificationPresenter.ToneOption("Brief", "brief", 4),
            ),
            tones,
        )
    }

    @Test fun `treats an empty string tone the same as absent`() {
        val tones = NotificationPresenter.availableTones("casual", "", "")
        assertEquals(listOf(NotificationPresenter.ToneOption("Casual", "casual", 0)), tones)
    }

    // ── actionBroadcastFor ───────────────────────────────────────────────────────

    @Test fun `maps known action types to their broadcast actions`() {
        assertEquals(ActionReceiver.ACTION_CALENDAR_ADD, NotificationPresenter.actionBroadcastFor("calendar_add"))
        assertEquals(ActionReceiver.ACTION_MAPS_OPEN, NotificationPresenter.actionBroadcastFor("maps_open"))
    }

    @Test fun `returns null for an unknown action type`() {
        assertNull(NotificationPresenter.actionBroadcastFor("follow_up"))
        assertNull(NotificationPresenter.actionBroadcastFor(""))
    }
}
