package com.contextreply.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContactMemoryTest {

    private val DAY_MS = 86_400_000L

    // ── parseExpiryMillis ────────────────────────────────────────────────────────

    @Test fun `parses a plain ISO date at local midnight`() {
        val millis = ContactMemory.parseExpiryMillis("2026-08-01")
        assertTrue(millis != null && millis > 0)
    }

    @Test fun `parses only the date portion of a longer ISO string`() {
        val fromDateOnly = ContactMemory.parseExpiryMillis("2026-08-01")
        val fromDateTime = ContactMemory.parseExpiryMillis("2026-08-01T00:00:00")
        assertEquals(fromDateOnly, fromDateTime)
    }

    @Test fun `returns null for blank or missing input`() {
        assertNull(ContactMemory.parseExpiryMillis(null))
        assertNull(ContactMemory.parseExpiryMillis(""))
    }

    @Test fun `returns null for unparseable input instead of throwing`() {
        assertNull(ContactMemory.parseExpiryMillis("not a date"))
    }

    // ── mergeTypedEntries ────────────────────────────────────────────────────────

    @Test fun `commitment without expiresAt defaults to 14 days out`() {
        val now = 1_000_000_000_000L
        val merged = ContactMemory.mergeTypedEntries(
            JSONArray(), listOf(TypedMemory("commitment", "Send the address", null)), now
        )
        val entry = merged.getJSONObject(0)
        assertEquals(now + 14 * DAY_MS, entry.getLong("expiresAt"))
        assertEquals("open", entry.getString("status"))
    }

    @Test fun `commitment with an explicit expiresAt uses that instead of the default`() {
        val now = 1_000_000_000_000L
        val explicit = ContactMemory.parseExpiryMillis("2026-08-01")!!
        val merged = ContactMemory.mergeTypedEntries(
            JSONArray(), listOf(TypedMemory("commitment", "Confirm by then", "2026-08-01")), now
        )
        assertEquals(explicit, merged.getJSONObject(0).getLong("expiresAt"))
    }

    @Test fun `preference never gets an expiresAt even if one was supplied`() {
        val now = 1_000_000_000_000L
        val merged = ContactMemory.mergeTypedEntries(
            JSONArray(), listOf(TypedMemory("preference", "Allergic to shellfish", "2026-08-01")), now
        )
        assertTrue(!merged.getJSONObject(0).has("expiresAt"))
    }

    @Test fun `blank text is skipped`() {
        val now = 1_000_000_000_000L
        val merged = ContactMemory.mergeTypedEntries(
            JSONArray(), listOf(TypedMemory("preference", "   ", null)), now
        )
        assertEquals(0, merged.length())
    }

    @Test fun `text is trimmed`() {
        val now = 1_000_000_000_000L
        val merged = ContactMemory.mergeTypedEntries(
            JSONArray(), listOf(TypedMemory("preference", "  Likes coffee  ", null)), now
        )
        assertEquals("Likes coffee", merged.getJSONObject(0).getString("text"))
    }

    @Test fun `appends to existing entries rather than replacing them`() {
        val now = 1_000_000_000_000L
        val existing = JSONArray().put(JSONObject().apply {
            put("type", "preference"); put("text", "Old fact"); put("createdAt", now); put("status", "open")
        })
        val merged = ContactMemory.mergeTypedEntries(
            existing, listOf(TypedMemory("preference", "New fact", null)), now
        )
        assertEquals(2, merged.length())
    }

    // ── pruneTyped ───────────────────────────────────────────────────────────────

    private fun typedEntry(type: String, text: String, status: String = "open", expiresAt: Long? = null) =
        JSONObject().apply {
            put("type", type); put("text", text); put("createdAt", 0L); put("status", status)
            if (expiresAt != null) put("expiresAt", expiresAt)
        }

    @Test fun `drops resolved entries`() {
        val now = 1_000_000_000_000L
        val arr = JSONArray().put(typedEntry("commitment", "Done thing", status = "resolved"))
        assertEquals(0, ContactMemory.pruneTyped(arr, now).length())
    }

    @Test fun `drops entries whose expiresAt has passed`() {
        val now = 1_000_000_000_000L
        val arr = JSONArray().put(typedEntry("commitment", "Stale thing", expiresAt = now - DAY_MS))
        assertEquals(0, ContactMemory.pruneTyped(arr, now).length())
    }

    @Test fun `keeps entries whose expiresAt is still in the future`() {
        val now = 1_000_000_000_000L
        val arr = JSONArray().put(typedEntry("commitment", "Still open", expiresAt = now + DAY_MS))
        assertEquals(1, ContactMemory.pruneTyped(arr, now).length())
    }

    @Test fun `keeps preferences with no expiresAt indefinitely`() {
        val now = 1_000_000_000_000L
        val arr = JSONArray().put(typedEntry("preference", "Durable fact"))
        assertEquals(1, ContactMemory.pruneTyped(arr, now).length())
    }

    @Test fun `caps the total count keeping only the most recent`() {
        val now = 1_000_000_000_000L
        val arr = JSONArray()
        repeat(25) { i -> arr.put(typedEntry("preference", "Fact $i")) }
        val pruned = ContactMemory.pruneTyped(arr, now)
        assertEquals(20, pruned.length())
        assertEquals("Fact 24", pruned.getJSONObject(pruned.length() - 1).getString("text"))
    }

    // ── formatMemoryBlock ───────────────────────────────────────────────────────

    @Test fun `returns null when there is nothing to say`() {
        assertNull(ContactMemory.formatMemoryBlock(null, null, null))
    }

    @Test fun `includes a summary-only section when there are no rolling entries`() {
        val block = ContactMemory.formatMemoryBlock("Planning a trip", null, null)
        assertEquals("Past context about this contact: Planning a trip", block)
    }

    @Test fun `includes open commitments in their own section`() {
        val now = 1_000_000_000_000L
        val typed = JSONArray().put(typedEntry("commitment", "Send the venue address", expiresAt = now + DAY_MS))
        val block = ContactMemory.formatMemoryBlock(null, null, typed, now)
        assertTrue(block!!.contains("Open commitments with this contact:"))
        assertTrue(block.contains("- Send the venue address"))
    }

    @Test fun `includes preferences in a separate known-facts section`() {
        val typed = JSONArray().put(typedEntry("preference", "Allergic to shellfish"))
        val block = ContactMemory.formatMemoryBlock(null, null, typed)
        assertTrue(block!!.contains("Known facts about this contact:"))
        assertTrue(block.contains("- Allergic to shellfish"))
    }

    @Test fun `excludes expired commitments from the formatted block`() {
        val now = 1_000_000_000_000L
        val typed = JSONArray().put(typedEntry("commitment", "Old promise", expiresAt = now - DAY_MS))
        assertNull(ContactMemory.formatMemoryBlock(null, null, typed, now))
    }

    @Test fun `excludes resolved commitments from the formatted block`() {
        val typed = JSONArray().put(typedEntry("commitment", "Done thing", status = "resolved"))
        assertNull(ContactMemory.formatMemoryBlock(null, null, typed))
    }

    @Test fun `combines rolling entries and typed sections together`() {
        val now = 1_000_000_000_000L
        val entries = JSONArray().put(JSONObject().apply { put("ts", now); put("text", "Mentioned a new job") })
        val typed = JSONArray().put(typedEntry("preference", "Vegetarian"))
        val block = ContactMemory.formatMemoryBlock(null, entries, typed, now)!!
        assertTrue(block.contains("Past context about this contact (most recent first):"))
        assertTrue(block.contains("Known facts about this contact:"))
    }
}
