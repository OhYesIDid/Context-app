package com.contextreply.app

import org.json.JSONArray
import org.json.JSONObject

// Pure decision logic for the contact-linking flow, extracted from ProTxtBgService.kt's
// contactMatchJson (part of its God Class split — see that file's history). ProTxtBgService
// keeps everything Context-dependent (SharedPreferences reads/writes via Prefs, the actual
// ContactMatcher lookups against cached/device contacts) and calls into this object only
// once it already has a phone match and/or name matches in hand — no I/O happens here.
object ContactLinking {

    // What contactMatchJson should do once a match decision has been made:
    //  - json: the banner payload to return to the caller, or null if no banner is needed
    //  - confirmIdentity: the contactId to silently persist as confirmed under this convKey,
    //    or null if nothing should be persisted (a banner was shown instead, pending the
    //    user's explicit confirmation)
    data class ContactMatchDecision(val json: String?, val confirmIdentity: String? = null)

    // Returns (true, sourcePkg) when contactId is already linked from a different package.
    // Synthetic auto:/sep: IDs are per-sender and never constitute a cross-app link.
    fun crossAppLink(contactId: String, currentConvKey: String, confirmed: JSONObject): Pair<Boolean, String> {
        if (contactId.startsWith("auto:") || contactId.startsWith("sep:")) return false to ""
        val currentPkg = currentConvKey.substringBefore(":")
        for (key in confirmed.keys()) {
            if (confirmed.optString(key) == contactId) {
                val existingPkg = key.substringBefore(":")
                if (existingPkg != currentPkg) return true to existingPkg
            }
        }
        return false to ""
    }

    // Decides what contactMatchJson should do given an already-confirmed sender is NOT the
    // case (caller checks `confirmed.has(convKey)` before ever calling this) — either:
    //  - a verified phone match (confidence 1.0, auto-confirmed silently unless it would
    //    cross-link a different app package, in which case the user must approve via banner)
    //  - one or more fuzzy name matches (never auto-confirmed, regardless of confidence — an
    //    unsaved sender could set their display name to any real contact's name by
    //    coincidence, so linking on name alone risks permanently misattributing a stranger's
    //    messages/memory/follow-ups)
    //  - no match at all (auto-registers a synthetic "auto:" id so the banner never repeats)
    fun decideContactMatch(
        convKey: String,
        senderName: String,
        confirmed: JSONObject,
        phoneMatch: MatchResult?,
        nameMatches: List<MatchResult>,
    ): ContactMatchDecision {
        if (phoneMatch != null) {
            val (crossApp, srcPkg) = crossAppLink(phoneMatch.contactId, convKey, confirmed)
            if (!crossApp) {
                return ContactMatchDecision(json = null, confirmIdentity = phoneMatch.contactId)
            }
            val json = JSONObject().apply {
                put("contactId", phoneMatch.contactId)
                put("displayName", phoneMatch.displayName)
                put("preferredTone", phoneMatch.preferredTone ?: "")
                put("confidence", 1.0)
                put("crossApp", true)
                put("crossAppSourceLabel", IntentAndSignals.appLabel(srcPkg))
                put("candidates", JSONArray())
            }.toString()
            return ContactMatchDecision(json = json)
        }

        val primary = nameMatches.firstOrNull() ?: run {
            // No contact found anywhere — auto-register so the banner never repeats.
            val autoId = "auto:${senderName.lowercase().replace(Regex("[^a-z0-9]"), "_").take(40)}"
            return ContactMatchDecision(json = null, confirmIdentity = autoId)
        }

        val (crossApp, srcPkg) = crossAppLink(primary.contactId, convKey, confirmed)
        val json = JSONObject().apply {
            put("contactId", primary.contactId)
            put("displayName", primary.displayName)
            put("preferredTone", primary.preferredTone ?: "")
            put("confidence", primary.confidence)
            if (crossApp) { put("crossApp", true); put("crossAppSourceLabel", IntentAndSignals.appLabel(srcPkg)) }
            put("candidates", JSONArray().also { arr ->
                for (c in nameMatches) arr.put(JSONObject().apply {
                    put("contactId", c.contactId)
                    put("displayName", c.displayName)
                    put("preferredTone", c.preferredTone ?: "")
                    put("confidence", c.confidence)
                })
            })
        }.toString()
        return ContactMatchDecision(json = json)
    }
}
