package com.contextreply.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactLinkingTest {

    // ── crossAppLink ─────────────────────────────────────────────────────────────

    @Test fun `detects a contact already confirmed under a different package`() {
        val confirmed = JSONObject().put("com.whatsapp:Alice", "contact-1")
        val (isCrossApp, sourcePkg) = ContactLinking.crossAppLink("contact-1", "org.telegram.messenger:Alice", confirmed)
        assertTrue(isCrossApp)
        assertEquals("com.whatsapp", sourcePkg)
    }

    @Test fun `is not cross-app when the only confirmed entry is from the same package`() {
        val confirmed = JSONObject().put("com.whatsapp:Alice", "contact-1")
        val (isCrossApp, _) = ContactLinking.crossAppLink("contact-1", "com.whatsapp:Alice", confirmed)
        assertFalse(isCrossApp)
    }

    @Test fun `synthetic auto- and sep- ids never count as a cross-app link`() {
        val confirmed = JSONObject().put("com.whatsapp:Alice", "auto:alice")
        val (isCrossApp, _) = ContactLinking.crossAppLink("auto:alice", "org.telegram.messenger:Alice", confirmed)
        assertFalse(isCrossApp)
    }

    // ── decideContactMatch — phone match ─────────────────────────────────────────

    @Test fun `silently auto-confirms a phone match from the same package`() {
        val phoneMatch = MatchResult("contact-1", "Alice", "casual", 1.0)
        val decision = ContactLinking.decideContactMatch(
            "com.whatsapp:Alice", "Alice", confirmed = JSONObject(), phoneMatch = phoneMatch, nameMatches = emptyList()
        )

        assertNull(decision.json)
        assertEquals("contact-1", decision.confirmIdentity)
    }

    @Test fun `shows a banner instead of auto-confirming a cross-app phone match`() {
        val confirmed = JSONObject().put("com.whatsapp:Alice", "contact-1")
        val phoneMatch = MatchResult("contact-1", "Alice", "casual", 1.0)
        val decision = ContactLinking.decideContactMatch(
            "org.telegram.messenger:Alice", "Alice", confirmed, phoneMatch, nameMatches = emptyList()
        )

        assertNull(decision.confirmIdentity) // never silently persisted for a cross-app match
        val json = JSONObject(decision.json!!)
        assertEquals("contact-1", json.getString("contactId"))
        assertEquals(1.0, json.getDouble("confidence"), 0.0001)
        assertTrue(json.getBoolean("crossApp"))
        assertEquals("WhatsApp", json.getString("crossAppSourceLabel"))
        assertEquals(0, json.getJSONArray("candidates").length())
    }

    // ── decideContactMatch — name matches ────────────────────────────────────────

    @Test fun `always shows a banner for a name-only match, never auto-confirms`() {
        val nameMatch = MatchResult("contact-2", "Bob Smith", null, 0.95)
        val decision = ContactLinking.decideContactMatch(
            "com.whatsapp:Bob", "Bob", confirmed = JSONObject(), phoneMatch = null, nameMatches = listOf(nameMatch)
        )

        assertNull(decision.confirmIdentity) // name-only match is never silently persisted
        val json = JSONObject(decision.json!!)
        assertEquals("contact-2", json.getString("contactId"))
        assertEquals("Bob Smith", json.getString("displayName"))
        assertFalse(json.has("crossApp"))
        assertEquals(1, json.getJSONArray("candidates").length())
    }

    @Test fun `includes every candidate in the banner when multiple name matches exist`() {
        val candidates = listOf(
            MatchResult("contact-2", "Bob Smith", null, 0.95),
            MatchResult("contact-3", "Bobby Jones", "formal", 0.80),
        )
        val decision = ContactLinking.decideContactMatch(
            "com.whatsapp:Bob", "Bob", confirmed = JSONObject(), phoneMatch = null, nameMatches = candidates
        )

        val json = JSONObject(decision.json!!)
        assertEquals("contact-2", json.getString("contactId")) // primary = first (highest confidence)
        val arr = json.getJSONArray("candidates")
        assertEquals(2, arr.length())
        assertEquals("contact-3", arr.getJSONObject(1).getString("contactId"))
        assertEquals("formal", arr.getJSONObject(1).getString("preferredTone"))
    }

    @Test fun `flags cross-app on a name match too, alongside its candidates`() {
        val confirmed = JSONObject().put("com.whatsapp:Bob", "contact-2")
        val nameMatch = MatchResult("contact-2", "Bob Smith", null, 0.95)
        val decision = ContactLinking.decideContactMatch(
            "org.telegram.messenger:Bob", "Bob", confirmed, phoneMatch = null, nameMatches = listOf(nameMatch)
        )

        val json = JSONObject(decision.json!!)
        assertTrue(json.getBoolean("crossApp"))
        assertEquals("WhatsApp", json.getString("crossAppSourceLabel"))
        assertEquals(1, json.getJSONArray("candidates").length())
    }

    // ── decideContactMatch — no match at all ─────────────────────────────────────

    @Test fun `auto-registers a synthetic id when nothing matches, so the banner never repeats`() {
        val decision = ContactLinking.decideContactMatch(
            "com.whatsapp:Some Random Person!", "Some Random Person!",
            confirmed = JSONObject(), phoneMatch = null, nameMatches = emptyList(),
        )

        assertNull(decision.json)
        assertEquals("auto:some_random_person_", decision.confirmIdentity)
    }

    @Test fun `truncates an overly long sender name in the synthetic id`() {
        val longName = "a".repeat(100)
        val decision = ContactLinking.decideContactMatch(
            "com.whatsapp:$longName", longName, confirmed = JSONObject(), phoneMatch = null, nameMatches = emptyList(),
        )

        assertEquals("auto:" + "a".repeat(40), decision.confirmIdentity)
    }
}
