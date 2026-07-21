package com.contextreply.app

// Pure notification-content-shaping logic extracted from ProTxtBgService.kt's three
// post*Notification functions (part of its God Class split). The actual NotificationCompat
// .Builder/PendingIntent/RemoteInput/BubbleHelper.attach work stays in ProTxtBgService — it
// needs a real Context and builds genuine Android framework objects, which would need
// Robolectric to test meaningfully. What's here needed neither.
object NotificationPresenter {

    // Was identically duplicated across postLoadingNotification, postErrorNotification, and
    // postSuggestionNotification. Null for anonymized "id:"-prefixed convKeys (no sender name
    // to show); "Group chat" for group conversations; otherwise the sender's name, stripped
    // of any "AppName: " prefix and truncated to fit the notification title.
    fun contactLabel(convKey: String): String? {
        val key = convKey.substringAfter(":")
        return when {
            key.startsWith("group:") -> "Group chat"
            key.startsWith("id:") -> null
            else -> IntentAndSignals.stripAppPrefix(key).take(30)
        }
    }

    // requestCodeOffset is added to the notification's own notifId to build that tone's
    // PendingIntent request code — these specific offsets (0/3/4) are load-bearing, baked
    // into existing notification request codes, not just arbitrary list positions (e.g. if
    // Formal is absent, Brief still uses offset 4, not 1 — preserved exactly here rather
    // than derived from the list index).
    data class ToneOption(val label: String, val text: String, val requestCodeOffset: Int)

    // Casual is always present; Formal/Brief only when non-empty.
    fun availableTones(casual: String, formal: String?, brief: String?): List<ToneOption> = buildList {
        add(ToneOption("Casual", casual, 0))
        if (!formal.isNullOrEmpty()) add(ToneOption("Formal", formal, 3))
        if (!brief.isNullOrEmpty()) add(ToneOption("Brief", brief, 4))
    }

    // Maps a Claude-suggested structured action's type to the broadcast action that handles
    // it, or null for an action type with no corresponding notification button.
    fun actionBroadcastFor(actionType: String): String? = when (actionType) {
        "calendar_add" -> ActionReceiver.ACTION_CALENDAR_ADD
        "maps_open" -> ActionReceiver.ACTION_MAPS_OPEN
        else -> null
    }
}
