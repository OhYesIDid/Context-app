package com.contextreply.app

// The two purely textual gates from ProTxtBgService.kt's onNotificationPosted, extracted as
// part of its God Class split. Deliberately narrow: onNotificationPosted has 7 gates total,
// but the other 5 either need real Android Notification.Action objects or live instance state
// (recentlySentAt, thread history, arrivalBuffer) — those, and all the debounce/state-mutation
// orchestration around every gate, stay in ProTxtBgService. Only these two ever depended on
// nothing but plain strings.
object NotificationGating {

    private val NO_REPLY_TEXT_PATTERNS = listOf(
        Regex("^(WhatsApp |Telegram )?(audio |video )?call$", RegexOption.IGNORE_CASE),
        Regex("^missed (voice |video )?call", RegexOption.IGNORE_CASE),
        Regex("\\bmissed call\\b", RegexOption.IGNORE_CASE),
        Regex("^(voice|video) message$", RegexOption.IGNORE_CASE),
        // Reactions — "reacted to your message", "reacted ❤️ to", "reacted with ❤️"
        Regex("reacted to your (message|story|photo|reel|post)", RegexOption.IGNORE_CASE),
        Regex("reacted .{0,6} to (your|a|the)", RegexOption.IGNORE_CASE),
        Regex("reacted with", RegexOption.IGNORE_CASE),
        Regex("^message react$", RegexOption.IGNORE_CASE),
        Regex("liked your (message|photo|reel|story|post)", RegexOption.IGNORE_CASE),
        Regex("commented on your (photo|reel|post|story)", RegexOption.IGNORE_CASE),
        Regex("(started following|accepted your follow request|sent you a follow request)", RegexOption.IGNORE_CASE),
        Regex("mentioned you in (a comment|their story|a post)", RegexOption.IGNORE_CASE),
        Regex("^(offer|deal|sale|discount|promo|limited time)", RegexOption.IGNORE_CASE),
        Regex("^\\d+ (new )?messages?$", RegexOption.IGNORE_CASE),
        Regex("^\\d+ (new )?notifications?$", RegexOption.IGNORE_CASE),
    )

    private val INSTAGRAM_NON_DM_TITLE_PATTERNS = listOf(
        Regex("^Instagram$", RegexOption.IGNORE_CASE),
        Regex("^(activity|your post|your reel|your story|your photo)", RegexOption.IGNORE_CASE),
    )

    // Gate 3 — filters call/missed-call/reaction/like/follow/promo notification content that
    // passed the earlier category/reply-action gates but isn't a real message to reply to.
    fun isNoReplyText(title: String, text: String): Boolean =
        NO_REPLY_TEXT_PATTERNS.any { it.containsMatchIn(text) || it.containsMatchIn(title) }

    // Gate 4 — Instagram-specific: distinguishes a real DM from an engagement notification
    // (likes/comments/follows/activity digest). Expects the title already stripped of any
    // "Instagram: " prefix (see IntentAndSignals.stripAppPrefix) — matching the raw title
    // let a bare "Instagram" pattern swallow every real DM whose title contains the app name.
    fun isInstagramNonDmTitle(strippedTitle: String): Boolean =
        INSTAGRAM_NON_DM_TITLE_PATTERNS.any { it.containsMatchIn(strippedTitle) }
}
