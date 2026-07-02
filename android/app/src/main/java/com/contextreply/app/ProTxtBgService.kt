package com.contextreply.app

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.NotificationListenerService.RankingMap
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.signin.GoogleSignIn
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class ProTxtBgService : NotificationListenerService() {

    companion object {
        @Volatile private var instance: ProTxtBgService? = null
        fun getInstance(): ProTxtBgService? = instance

        const val CHANNEL_ID = "contextreply_suggestions"
        const val CHANNEL_SILENT_ID = "contextreply_silent"
        const val ACTION_SEND = "com.contxt.app.ACTION_SEND_REPLY"
        const val ACTION_DISMISS = "com.contxt.app.ACTION_DISMISS_REPLY"
        const val ACTION_COPY = "com.contxt.app.ACTION_COPY_REPLY"
        const val ACTION_MARK_READ = "com.contxt.app.ACTION_MARK_READ"
        const val ACTION_RETRY = "com.contxt.app.ACTION_RETRY_REPLY"
        const val EXTRA_REPLY_TEXT = "reply_text"
        const val EXTRA_REPLY_FORMAL = "reply_formal"
        const val EXTRA_REPLY_BRIEF = "reply_brief"
        const val EXTRA_REMOTE_INPUT_KEY = "remote_input_key"
        const val EXTRA_NOTIF_ID = "notif_id"
        const val EXTRA_CONV_KEY = "conv_key"
        const val EXTRA_INTENT   = "reply_intent"
        const val EXTRA_INTENTS        = "reply_intents"
        const val EXTRA_MESSAGE        = "reply_message"
        const val EXTRA_PREFERRED_TONE = "reply_preferred_tone"
        const val EXTRA_OPEN_CHAT_INTENT = "open_chat_intent"
        const val ACTION_OPEN_CHAT = "com.contxt.app.ACTION_OPEN_CHAT"
        const val EXTRA_ACTION_JSON = "action_json"
        const val EXTRA_CONTACT_MATCH_JSON = "contact_match_json"
        const val EXTRA_SUGGESTION_TS = "suggestion_ts"
        const val EXTRA_NO_REPLY = "no_reply"
        const val EXTRA_SKIP_CANCEL = "skip_cancel"
        const val EXTRA_ORIGINAL_SUGGESTION = "original_suggestion"
        const val EXTRA_TONE_SELECTED = "tone_selected"
        const val REMOTE_INPUT_KEY = "contextreply_edited_reply"
        // Sentinel placed in EXTRA_REPLY_TEXT while the worker is in-flight.
        // BubbleSuggestionActivity detects this and shows a loading state.
        const val LOADING_PLACEHOLDER = "__loading__"
        // Sentinel placed in EXTRA_REPLY_TEXT when the worker failed or timed out.
        // BubbleSuggestionActivity detects this and shows a retry state.
        const val ERROR_PLACEHOLDER = "__error__"

        // Stores suggestion args so bubbles can be re-posted after screen unlock / call end.
        data class PendingBubble(
            val replyText: String,
            val formalText: String?,
            val briefText: String?,
            val replyPendingIntent: PendingIntent,
            val remoteInputKey: String,
            val notifId: Int,
            val convKey: String,
            val intent: String?,
            val openChatIntent: PendingIntent?,
            val message: String,
            val detectedIntents: String,
            val suggestedActionJson: String?,
            val markAsReadPendingIntent: PendingIntent?,
        )
        val pendingBubbles = ConcurrentHashMap<String, PendingBubble>()

        // Collapses rapid-fire messages from the same thread into one API call
        private const val DEBOUNCE_MS = 2_500L

        // Safety net for the worker job: enrichment calls (e.g. GoogleAuthUtil.getToken())
        // have no caller-side timeout and can block the pool thread indefinitely, and
        // without this, a single hung call leaves the loading notification stuck forever
        // since nothing else ever clears activeBubbles/replaces the notification for that
        // convKey. Must safely exceed WorkerClient's own worst case, which is NOT 30s —
        // 3 attempts (initial + MAX_RETRIES=2) x (15s connect + 15s read) + 2x1s retry
        // delay = ~92s. A shorter timeout here fires while WorkerClient is still validly
        // retrying, cancelling the bubble and then discarding the eventual result.
        private const val WORKER_TIMEOUT_MS = 100_000L

        val TARGET_PACKAGES = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.telegram.messenger",
            "com.facebook.orca",
            "org.thoughtcrime.securesms",
            "com.google.android.apps.messaging",
            "com.instagram.android",
        )

        // Dialer packages whose ongoing call notification removal signals call-end.
        // Used instead of READ_PHONE_STATE + PhoneStateListener.
        private val DIALER_PACKAGES = setOf(
            "com.google.android.dialer",
            "com.google.android.apps.dialer",
            "com.android.phone",
            "com.samsung.android.dialer",
            "com.coloros.dialer",
            "com.oppo.contacts",
            "com.vivo.contacts",
            "com.miui.phone",
            "com.motorola.dialer",
            "com.htc.android.phone",
            "com.oneplus.dialer",
        )

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
            Regex("\\bInstagram\\b", RegexOption.IGNORE_CASE),
            Regex("^(activity|your post|your reel|your story|your photo)", RegexOption.IGNORE_CASE),
        )

        // Strips "AppName: " prefixes that messaging apps prepend to contact names in their
        // notification titles (e.g. "WhatsApp: Maya Hinge" → "Maya Hinge"). Only strips
        // single-word prefixes so group names like "Ski - Val d'isere" are left intact.
        fun stripAppPrefix(key: String): String {
            val colonSpace = key.indexOf(": ")
            if (colonSpace <= 0) return key
            val prefix = key.substring(0, colonSpace)
            return if (prefix.none { it == ' ' }) key.substring(colonSpace + 2) else key
        }

        fun packageToPlatform(pkg: String): String? = when {
            pkg.contains("whatsapp")                               -> "whatsapp"
            pkg.contains("telegram")                               -> "telegram"
            pkg.contains("instagram")                              -> "instagram"
            pkg.contains("messenger") || pkg.contains("facebook")  -> "messenger"
            pkg.contains("signal")                                 -> "signal"
            pkg.contains("google.android.apps.messaging")          -> "sms"
            else -> null
        }

        fun appLabel(pkg: String): String = when {
            pkg.contains("whatsapp")                          -> "WhatsApp"
            pkg.contains("telegram")                          -> "Telegram"
            pkg.contains("hinge")                             -> "Hinge"
            pkg.contains("tinder")                            -> "Tinder"
            pkg.contains("bumble")                            -> "Bumble"
            pkg.contains("instagram")                         -> "Instagram"
            pkg.contains("messenger") || pkg.contains("facebook") -> "Messenger"
            pkg.contains("signal")                            -> "Signal"
            pkg.contains("snapchat")                          -> "Snapchat"
            pkg.contains("twitter") || pkg.contains(".x.")    -> "X"
            pkg.contains("viber")                             -> "Viber"
            pkg.contains("discord")                           -> "Discord"
            else -> pkg.substringAfterLast(".").replaceFirstChar { it.uppercase() }
        }
    }

    private val pendingJobs   = ConcurrentHashMap<String, ScheduledFuture<*>>()
    // Unanswered message backlog per conversation. Survives across debounce firings —
    // only cleared when the user actually sends/dismisses or replies directly in-app
    // (see arrivalBuffer.remove call sites). This lets a message that arrives just
    // outside the debounce window still be shown together with an earlier message
    // whose suggestion is still pending.
    val arrivalBuffer = ConcurrentHashMap<String, MutableList<String>>()
    // Tracks convKeys that currently have a live bubble so we don't stack duplicates.
    // Cleared by ReplySendReceiver on send or dismiss.
    val activeBubbles = ConcurrentHashMap.newKeySet<String>()
    // Tracks which convKeys belong to group conversations so we can bulk-dismiss them
    // when skip_group_messages is toggled on. Groups often use the group name as convKey
    // rather than a "group:" prefix, so we can't identify them by string alone.
    val groupConvKeys = ConcurrentHashMap.newKeySet<String>()
    // Maps convKey → most recent WhatsApp/Telegram sbn.id for that conversation.
    // Stable per-conversation even when the notification title changes (e.g. "You" on outbound).
    val sbnIdByConvKey = ConcurrentHashMap<String, Int>()
    // Reverse map: "$packageName:$sbnId" → convKey, for resolving outbound notifications.
    private val sbnKeyToConvKey = ConcurrentHashMap<String, String>()
    // Timestamp of the most recent outbound send, keyed by "$packageName:$sbnId".
    // Suppresses the notification update the messaging app posts after a RemoteInput reply.
    val recentlySentAt = ConcurrentHashMap<String, Long>()
    private val SENT_COOLDOWN_MS = 5_000L
    private val lastOpenedTimestamp = ConcurrentHashMap<String, Long>()
    // Tracks the most recently detected non-other intent per conversation.
    // Used for intent inheritance: a follow-up message ("what time works?") that
    // doesn't independently match intent patterns can inherit the intent from a
    // recent context message ("are you free saturday?") in the same thread.
    // Session-scoped (in-memory only) — if the service restarts, the window is lost,
    // which is acceptable since a restart takes longer than a typical follow-up gap.
    private val conversationIntents = ConcurrentHashMap<String, Pair<String, Long>>()
    // How many messages back in the notification bundle to scan for intent context.
    private val INTENT_LOOKBACK_COUNT = 6
    // How long (ms) a detected intent remains eligible for inheritance.
    private val INTENT_LOOKBACK_WINDOW_MS = 30 * 60 * 1000L
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val workerPool = Executors.newFixedThreadPool(3)
    private lateinit var store: NotificationStore

    @Volatile private var lastLocation: Location? = null
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            // Reject fixes older than 2 minutes — the network provider sometimes delivers
            // a stale cached location immediately on registration (e.g. last known home fix).
            if (System.currentTimeMillis() - loc.time <= 2 * 60 * 1_000L) lastLocation = loc
        }
        @Deprecated("Deprecated in Java") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
    }

    // Fires when the keyguard is dismissed — re-post any pending bubbles.
    private val restoreBubblesReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (pendingBubbles.isEmpty()) return
            Handler(Looper.getMainLooper()).postDelayed({ repostPendingBubbles(fromUnlock = true) }, 600L)
        }
    }

    // Fired by the ConTxt Keyboard (ConTxtBridge) when the user sends a message via the
    // keyboard's IME send action. Clears the pending bubble/suggestion for that conversation.
    private val keyboardSentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val convKey = intent.getStringExtra("conv_key") ?: return
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notifId = convKey.hashCode().and(0x7FFFFFFF)
            nm.cancel(notifId)
            activeBubbles.remove(convKey)
            arrivalBuffer.remove(convKey)
            pendingBubbles.remove(convKey)
            NotificationStore.getInstance(context).markReplied(convKey)
        }
    }

    // Re-feed all active notifications through onNotificationPosted so that group messages
    // already sitting in the shade get picked up as bubbles after skip is turned off.
    internal fun activateGroupNotifications() {
        Handler(Looper.getMainLooper()).post {
            try {
                getActiveNotifications()?.forEach { sbn -> onNotificationPosted(sbn) }
            } catch (_: Exception) {}
        }
    }

    // Re-feed active notifications when "suggest all messages" is turned on so that
    // any conversations already in the shade that were skipped (other intent, toggle was off)
    // immediately get bubbles and suggestions without waiting for a new message.
    internal fun replayActiveNotifications() {
        Handler(Looper.getMainLooper()).post {
            try {
                getActiveNotifications()?.forEach { sbn -> onNotificationPosted(sbn) }
            } catch (_: Exception) {}
        }
    }

    // Dismiss bubbles that were posted purely because suggest_all was on (intent == "other").
    // Called when the toggle is turned off so non-context-matched bubbles disappear immediately.
    internal fun dismissOtherIntentBubbles() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val toRemove = pendingBubbles.entries
            .filter { (_, b) -> b.detectedIntents == "other" }
            .map { it.key }
        for (convKey in toRemove) {
            val notifId = convKey.hashCode().and(0x7FFFFFFF)
            nm.cancel(notifId)
            activeBubbles.remove(convKey)
            arrivalBuffer.remove(convKey)
            pendingBubbles.remove(convKey)
            pendingJobs[convKey]?.cancel(false)
            pendingJobs.remove(convKey)
        }
    }

    internal fun dismissAllGroupBubbles() {
        // Reload from SharedPrefs in case the service restarted since group messages arrived
        val prefs = Prefs.main(this)
        val arr = try { JSONArray(prefs.getString("group_conv_keys", "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
        for (i in 0 until arr.length()) groupConvKeys.add(arr.optString(i))

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        for (convKey in groupConvKeys.toList()) {
            val notifId = convKey.hashCode().and(0x7FFFFFFF)
            nm.cancel(notifId)
            activeBubbles.remove(convKey)
            arrivalBuffer.remove(convKey)
            pendingBubbles.remove(convKey)
            pendingJobs[convKey]?.cancel(false)
            pendingJobs.remove(convKey)
            NotificationStore.getInstance(this).markReplied(convKey)
        }
        // Clear persisted set — cancelled bubbles no longer need tracking
        prefs.edit().putString("group_conv_keys", "[]").apply()
        groupConvKeys.clear()
    }

    // Called when bubbles are found to be disabled (system setting or per-app preference).
    // Re-posts every pending suggestion as a regular notification so replies are still visible.
    internal fun downgradeBubblesIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val nm = getSystemService(NotificationManager::class.java)
        val bubblesAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            nm.bubblePreference != NotificationManager.BUBBLE_PREFERENCE_NONE
        } else {
            @Suppress("DEPRECATION") nm.areBubblesEnabled()
        }
        if (bubblesAllowed) return
        for (pb in pendingBubbles.values.toList()) {
            val action = pb.suggestedActionJson?.let {
                try { org.json.JSONObject(it) } catch (_: Exception) { null }
            }
            postSuggestionNotification(
                replyText = pb.replyText,
                formalText = pb.formalText,
                briefText = pb.briefText,
                replyPendingIntent = pb.replyPendingIntent,
                remoteInputKey = pb.remoteInputKey,
                notifId = pb.notifId,
                convKey = pb.convKey,
                intent = pb.intent,
                openChatIntent = pb.openChatIntent,
                message = pb.message,
                detectedIntents = pb.detectedIntents,
                suggestedAction = action,
                markAsReadPendingIntent = pb.markAsReadPendingIntent,
                repost = true,
            )
        }
    }

    // fromUnlock=true  → skip repost entirely if the notification is still active — Android
    //   reinstates bubbles automatically; reposting causes a visible notification flash before
    //   the bubble metadata is processed. Only repost if the notification was cleared while locked.
    // fromUnlock=false → cancel then re-post with PRIORITY_HIGH so Android treats the notification
    //   as brand-new and promotes overflow/inactive bubbles back to active. setOnlyAlertOnce(true)
    //   on suggestion notifications suppresses re-alerting for already-active ones, but that flag
    //   only takes effect when the notification EXISTS — after a cancel the next post is always fresh.
    //   Expanded bubbles (BubbleSuggestionActivity alive) are protected from cancel to avoid closing
    //   the open activity.
    internal fun repostPendingBubbles(fromUnlock: Boolean = false) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val activeIds: Set<Int> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            nm.activeNotifications.map { it.id }.toSet() else emptySet()
        for ((_, b) in pendingBubbles) {
            // Notification is still live — Android will reinstate the bubble on its own.
            // Skipping the repost eliminates the brief shade flash on unlock.
            if (fromUnlock && activeIds.contains(b.notifId)) continue
            val isExpanded = BubbleSuggestionActivity.onReplyReady.containsKey(b.convKey)
            if (!fromUnlock && !isExpanded) nm.cancel(b.notifId)
            if (b.replyText == LOADING_PLACEHOLDER) {
                postLoadingNotification(
                    b.notifId, b.convKey, b.replyPendingIntent,
                    b.remoteInputKey, b.openChatIntent, b.message, b.detectedIntents,
                    b.markAsReadPendingIntent, repost = fromUnlock,
                )
            } else if (b.replyText == ERROR_PLACEHOLDER) {
                postErrorNotification(
                    b.notifId, b.convKey, b.replyPendingIntent,
                    b.remoteInputKey, b.openChatIntent, b.message, b.detectedIntents,
                    b.markAsReadPendingIntent, repost = fromUnlock,
                )
            } else {
                val sa = b.suggestedActionJson?.let { try { JSONObject(it) } catch (_: Exception) { null } }
                postSuggestionNotification(
                    b.replyText, b.formalText, b.briefText,
                    b.replyPendingIntent, b.remoteInputKey, b.notifId, b.convKey,
                    b.intent, b.openChatIntent, b.message, b.detectedIntents, sa,
                    markAsReadPendingIntent = b.markAsReadPendingIntent, repost = fromUnlock,
                )
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Prefs.migrateLegacy(this)
        instance = this
        store = NotificationStore.getInstance(this)
        createChannel()
        HomeDetectionWorker.schedule(this)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Prefs.main(this).edit()
            .putBoolean("nls_connected", true).apply()
        DeviceContactsResolver.populate(this)
        registerReceiver(restoreBubblesReceiver, IntentFilter(Intent.ACTION_USER_PRESENT))
        ContextCompat.registerReceiver(this, keyboardSentReceiver, IntentFilter("com.contxt.keyboard.ACTION_SENT"), ContextCompat.RECEIVER_EXPORTED)
        // Keep location live — short interval so lastLocation is always current.
        // No fallback to getLastKnownLocation(); stale cache is worse than no data.
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        lm?.let { mgr ->
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).forEach { provider ->
                try {
                    if (mgr.isProviderEnabled(provider))
                        mgr.requestLocationUpdates(provider, 15_000L, 10f, locationListener, mainLooper)
                } catch (_: SecurityException) {}
            }
        }
        // Process notifications already in the shade (e.g. after reinstall / service restart).
        // Short delay gives the service time to fully bind before reading active notifications.
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                getActiveNotifications()?.forEach { sbn -> onNotificationPosted(sbn) }
            } catch (_: Exception) {}
        }, 1_500L)
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Prefs.main(this).edit()
            .putBoolean("nls_connected", false).apply()
        try { unregisterReceiver(restoreBubblesReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(keyboardSentReceiver) } catch (_: Exception) {}
        try { (getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(locationListener) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        scheduler.shutdownNow()
        workerPool.shutdownNow()
        try { (getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(locationListener) } catch (_: Exception) {}
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in TARGET_PACKAGES) return

        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "notif from ${sbn.packageName} cat=${notification.category} actions=${notification.actions?.size ?: 0}")

        // Gate 0: skip group-summary notifications — WhatsApp/Telegram post one real
        // per-conversation notification (tagged with JID hash) and one summary notification
        // (FLAG_GROUP_SUMMARY, untagged). Both can pass subsequent gates but with different
        // titles → different convKeys → duplicate bubbles. Only process the real one.
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        // Gate 1: messaging category only
        if (notification.category != null && notification.category != Notification.CATEGORY_MESSAGE) {
            if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "filtered: wrong category ${notification.category}")
            return
        }

        // Gate 2: must have an inline-reply action
        val replyAction = notification.actions?.firstOrNull { action ->
            action?.remoteInputs?.isNotEmpty() == true
        } ?: run {
            if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "filtered: no reply action")
            return
        }

        val remoteInputKey = replyAction.remoteInputs?.firstOrNull()?.resultKey ?: return
        val replyPendingIntent = replyAction.actionIntent ?: return
        val openChatIntent = notification.contentIntent
        val markAsReadPendingIntent = notification.actions?.firstOrNull { action ->
            action?.remoteInputs.isNullOrEmpty() &&
            action?.title?.toString()?.lowercase()?.contains("read") == true
        }?.actionIntent

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: return

        // Gate 3: no-reply content patterns
        if (NO_REPLY_TEXT_PATTERNS.any { it.containsMatchIn(text) || it.containsMatchIn(title) }) return

        // Gate 4: Instagram engagement vs DM
        if (sbn.packageName == "com.instagram.android") {
            if (INSTAGRAM_NON_DM_TITLE_PATTERNS.any { it.containsMatchIn(title) }) return
        }

        // Gate 5: group messages — configurable
        val isGroup = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        if (isGroup && shouldSkipGroupMessages()) return

        val convKey = buildConversationKey(sbn, extras)
        val notifId = convKey.hashCode().and(0x7FFFFFFF)
        if (isGroup) {
            groupConvKeys.add(convKey)
            val prefs = Prefs.main(this)
            val arr = try { JSONArray(prefs.getString("group_conv_keys", "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
            var found = false
            for (i in 0 until arr.length()) { if (arr.optString(i) == convKey) { found = true; break } }
            if (!found) prefs.edit().putString("group_conv_keys", arr.put(convKey).toString()).apply()
        }

        // ── Accumulate messages in local store ───────────────────────────────
        // Extract the structured thread from this notification's bundle.
        val notifThread = extractConversationThread(extras)

        // Gate 6: suppress notification updates posted by the messaging app right after
        // a RemoteInput send. Two checks — apps vary in whether they null the sender:
        //   6a) sender=null on the last EXTRA_MESSAGES entry (standard Android convention)
        //   6b) cooldown keyed by "$packageName:sbnId" — stable across title changes (e.g.
        //       WhatsApp flips title to "You" on the outbound update, producing a different
        //       convKey, so we key on sbn.id which stays constant for the same thread.
        val sbnKey = "${sbn.packageName}:${sbn.id}"
        val sentAt = recentlySentAt[sbnKey]
        val withinCooldown = sentAt != null && System.currentTimeMillis() - sentAt < SENT_COOLDOWN_MS
        // Gate 6a: sender=null is the standard MessagingStyle convention for outbound messages.
        // Some apps (WhatsApp) use the user's display name instead of null — catch that too.
        val selfName = extras.getString(Notification.EXTRA_SELF_DISPLAY_NAME)
        val lastSender = notifThread.lastOrNull()?.first
        val lastMsgOutbound = notifThread.isNotEmpty() &&
            (lastSender == null || (selfName != null && lastSender == selfName))
        if (withinCooldown || lastMsgOutbound) {
            if (BuildConfig.DEBUG) android.util.Log.d("ProTxt",
                "filtered: post-send notification (cooldown=$withinCooldown outbound=$lastMsgOutbound sbnKey=$sbnKey)")
            // Dismiss the existing suggestion bubble — the user sent a reply directly
            // through the messaging app rather than via the bubble.
            val originalConvKey = sbnKeyToConvKey[sbnKey] ?: convKey
            val notifId = originalConvKey.hashCode().and(0x7FFFFFFF)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
            activeBubbles.remove(originalConvKey)
            arrivalBuffer.remove(originalConvKey)
            pendingJobs[originalConvKey]?.cancel(false)
            pendingJobs.remove(originalConvKey)
            // Clear the cached thread so the next incoming message starts a fresh context
            // rather than appending to a thread that predates the user's outbound reply.
            NotificationStore.getInstance(this).markReplied(originalConvKey)
            // Capture what the user sent so the next suggestion knows their last reply.
            if (lastMsgOutbound) {
                val outboundText = notifThread.last().second
                ContactMemory.saveLastSent(this, originalConvKey, outboundText)
            }
            return
        }

        // Record mappings so ReplySendReceiver can stamp the cooldown by sbn.id, and so
        // Gate 6 can resolve outbound notifications back to the original convKey.
        sbnIdByConvKey[convKey] = sbn.id
        sbnKeyToConvKey[sbnKey] = convKey

        // Only buffer after all gates — prevents outbound text from polluting the next
        // real message's burst context.
        arrivalBuffer.getOrPut(convKey) { mutableListOf() }.add(text)

        // Check for a mid-thread outbound message — this happens when the user replies directly
        // inside the messaging app (not via the bubble). WhatsApp cancels the notification on
        // direct reply rather than posting an update, so Gate 6 never fires. The NEXT inbound
        // notification carries the full updated EXTRA_MESSAGES bundle including the user's reply
        // with sender=null (or selfName) in the thread. We detect this case here and reseed from
        // after that reply so Claude only sees post-reply context.
        //
        // Guard: require at least one inbound message with a named sender. This confirms the app
        // uses proper MessagingStyle so a null/selfName sender can safely be read as outbound.
        // Without this check an app that never sets sender (non-MessagingStyle) would always
        // register the first null-sender message as an outbound reply and lose thread context.
        // We allow lastOutboundIdx == 0 (unlike the old > 0 guard) because WhatsApp often only
        // bundles [outbound, new-incoming] — the outbound at index 0 is still a valid signal.
        val lastOutboundIdx = notifThread.indexOfLast { (sender, _) ->
            sender == null || (selfName != null && sender == selfName)
        }
        val anyInboundNamed = notifThread.any { (sender, _) ->
            sender != null && (selfName == null || sender != selfName)
        }
        if (anyInboundNamed && lastOutboundIdx >= 0) {
            // User replied directly since our last cached snapshot — record what they sent, clear
            // the store, and reseed with only the inbound messages that came after their reply.
            val outboundText = notifThread[lastOutboundIdx].second
            ContactMemory.saveLastSent(this, convKey, outboundText)
            store.markReplied(convKey)
            notifThread.drop(lastOutboundIdx + 1).forEach { (sender, msgText) ->
                store.appendMessage(convKey, sender, msgText)
            }
        } else if (store.isEmpty(convKey)) {
            // No outbound in thread, first message from this conversation — seed store with
            // full EXTRA_MESSAGES context. WhatsApp/Telegram bundle recent history here,
            // giving Claude background on the thread from the very first notification.
            notifThread.forEach { (sender, msgText) ->
                store.appendMessage(convKey, sender, msgText)
            }
            // Mark all but the final (truly new) message as already-read history so the
            // bubble quote only shows the unread portion to the user.
            store.setUnreadStart(convKey, maxOf(0, notifThread.size - 1))
        } else {
            // Ongoing conversation, no direct reply detected — append only the new trigger
            // message, but only if it differs from the last stored entry. WhatsApp sometimes
            // fires multiple onNotificationPosted events for the same chat (delivery updates,
            // badge refresh) with identical EXTRA_MESSAGES content, which would cause the
            // last message to be stored twice and appear duplicated in the bubble thread view.
            notifThread.lastOrNull()?.let { (sender, msgText) ->
                val lastStored = store.getThread(convKey).lastOrNull()
                if (lastStored?.second != msgText) {
                    store.appendMessage(convKey, sender, msgText)
                }
            }
        }

        // Scan inbound messages from the notification bundle for intent context.
        // This captures intent signals from thread history (e.g. "are you free saturday?"
        // in the same thread as the arriving "what time works?" follow-up). The bundle
        // includes recent conversation history so this covers messages the user hasn't
        // yet replied to alongside new arrivals. Save with current timestamp so the
        // debounce block can inherit within the lookback window.
        val bundleInboundIntents = notifThread
            .takeLast(INTENT_LOOKBACK_COUNT)
            .filter { (sender, _) -> sender != null }
            .flatMap { (_, msgText) -> detectIntents(msgText) }
            .filter { it != "other" }
            .distinct()
        if (bundleInboundIntents.isNotEmpty()) {
            conversationIntents[convKey] = Pair(bundleInboundIntents.joinToString(","), System.currentTimeMillis())
        }

        // Debounce: cancel any existing scheduled call for this conversation and
        // reschedule. A burst of messages waits for the last one to settle.
        val packageName = sbn.packageName
        pendingJobs[convKey]?.cancel(false)
        // A new message in the same conversation supersedes any existing suggestion —
        // clear the active state so the fresh debounce generates a new one.
        activeBubbles.remove(convKey)
        pendingJobs[convKey] = scheduler.schedule({
            pendingJobs.remove(convKey)
            val fullThread = store.getThread(convKey)
            // Peek (don't drain) the arrival buffer — it holds every text that's arrived
            // since the last actual send/dismiss, not just this debounce window. A message
            // that arrives after this debounce already fired but before the user has acted
            // on the resulting suggestion still belongs in this still-pending backlog, so
            // it must still be here for the *next* debounce to pick up.
            val burstTexts = arrivalBuffer[convKey]
                ?.distinct()
                ?.takeIf { it.isNotEmpty() }
                ?: listOf(fullThread.lastOrNull()?.second ?: text)
            val latestMessage = burstTexts.joinToString("\n")
            if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "burst ${burstTexts.size} msgs ready")

            ContactSignals.recordIncoming(this, convKey)
            if (activeBubbles.contains(convKey)) return@schedule
            val directIntentsStr = detectIntents(latestMessage).joinToString(",")
            // Inherit intent from recent conversation context when the latest message
            // doesn't independently trigger one. E.g. "what time works?" (other intent)
            // inherits "availability" from "are you free saturday?" in the same thread
            // if that message was processed within the lookback window.
            val savedIntent = conversationIntents[convKey]
            val effectiveIntentsStr = if (directIntentsStr == "other" &&
                savedIntent != null &&
                System.currentTimeMillis() - savedIntent.second < INTENT_LOOKBACK_WINDOW_MS) {
                if (BuildConfig.DEBUG) android.util.Log.d("ProTxt",
                    "inheriting intent '${savedIntent.first}' from conversation context for $convKey")
                savedIntent.first
            } else directIntentsStr
            // Always refresh the stored intent when a real intent fires so follow-up messages
            // can inherit it — the bundle scan above only catches intents from EXTRA_MESSAGES
            // history; the direct detectIntents call on latestMessage is the ground truth.
            if (effectiveIntentsStr != "other") {
                conversationIntents[convKey] = Pair(effectiveIntentsStr, System.currentTimeMillis())
            }
            val suggestAll = try { Prefs.main(this).getBoolean("suggest_all_messages", false) } catch (_: Exception) { false }
            // Also process "other" intent messages when the current bubble for this conversation
            // has an open calendar action — the next message may carry the confirmed time/place
            // that should update the suggested event details.
            val hasPendingCalendarAction = pendingBubbles[convKey]?.suggestedActionJson
                ?.let { try { org.json.JSONObject(it).optString("type") == "calendar_add" } catch (_: Exception) { false } } == true
            if (!suggestAll && effectiveIntentsStr == "other" && !hasPendingCalendarAction) return@schedule
            activeBubbles.add(convKey)
            // If this convKey's bubble Activity is already open (the system never recreates
            // it to deliver a fresh Intent for later messages), push it back into a loading
            // state directly rather than leaving it stuck showing the previous reply.
            BubbleSuggestionActivity.onNewJobStarted[convKey]?.invoke(latestMessage)
            // Only show loading bubble when the user is not already in the messaging app.
            // When they are in the app, the IME overlay handles the suggestion instead.
            val userInApp = ProTxtAccessibilityService.activePackage == packageName
            if (!userInApp) {
                try {
                    postLoadingNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, effectiveIntentsStr, markAsReadPendingIntent)
                } catch (e: Exception) {
                    android.util.Log.e("ProTxt", "postLoadingNotification threw: ${e.javaClass.simpleName}: ${e.message}")
                }
            }
            runWorkerJob(
                convKey, notifId, latestMessage, effectiveIntentsStr,
                replyPendingIntent, remoteInputKey, openChatIntent,
                markAsReadPendingIntent, packageName, userInApp,
            )
        }, DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    // Submits the worker call for a conversation and arms the timeout watchdog. Shared by
    // the debounce-fire path above and retry() below, so a failed/timed-out call can be
    // re-run without duplicating the worker-submission and result-handling logic.
    private fun runWorkerJob(
        convKey: String,
        notifId: Int,
        latestMessage: String,
        detectedIntentsStr: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        openChatIntent: PendingIntent?,
        markAsReadPendingIntent: PendingIntent?,
        packageName: String,
        userInApp: Boolean,
    ) {
        val fullThread = store.getThread(convKey)
        val contactMemory = ContactMemory.buildMemoryBlock(this, convKey)
        val lastSent = ContactMemory.getLastSent(this, convKey)
        val contactContext = ContactSignals.getContactContext(this, convKey)
        val senderName = stripAppPrefix(convKey.substringAfter(":"))
        // Tracks whether THIS job has finished — distinct from activeBubbles, which stays
        // true for any live, un-actioned bubble (including a successful suggestion the user
        // just hasn't tapped yet). The watchdog must not mistake "still live" for "still
        // running", or it'll overwrite an already-successful suggestion with the error state
        // once its deadline passes, however long after the job actually completed.
        val jobDone = java.util.concurrent.atomic.AtomicBoolean(false)
        workerPool.submit {
            try {
                if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "job start: building enrichments")
                val enrichments = buildEnrichments(latestMessage, fullThread, convKey, detectedIntentsStr)
                if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "enrichments built, calling worker")
                val result = WorkerClient.call(
                    this, latestMessage, fullThread, enrichments,
                    contactMemory = contactMemory,
                    lastSentReply = lastSent,
                    contactContext = contactContext,
                    contactName = senderName,
                ) ?: run {
                    android.util.Log.e("ProTxt", "WorkerClient.call returned null")
                    if (activeBubbles.contains(convKey)) {
                        postErrorNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, detectedIntentsStr, markAsReadPendingIntent)
                    }
                    return@submit
                }
                if (result.rateLimited) {
                    if (activeBubbles.contains(convKey)) {
                        postErrorNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, "Too many requests — try again shortly", detectedIntentsStr, markAsReadPendingIntent)
                    }
                    return@submit
                }
                if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "worker call returned")
                // Persist context update + snippets, keyed by contactId where available
                ContactMemory.save(this, convKey, result.contextUpdate, result.snippets)
                // User may have dismissed the loading bubble — don't post a stale result
                if (!activeBubbles.contains(convKey)) return@submit
                val casual = result.replies.optString("casual").takeIf { it.isNotEmpty() }
                val formal = result.replies.optString("formal").takeIf { it.isNotEmpty() }
                val brief  = result.replies.optString("brief").takeIf { it.isNotEmpty() }
                val primary = casual ?: formal ?: brief ?: run {
                    postErrorNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, detectedIntentsStr, markAsReadPendingIntent)
                    return@submit
                }
                // Enrich share_location action with coordinates + area name so the
                // bubble/overlay can compose the full reply without geocoding at tap time.
                val finalAction = result.action?.also { action ->
                    if (action.optString("type") == "share_location") {
                        getCurrentLocation()?.let { loc ->
                            action.put("lat", loc.latitude)
                            action.put("lon", loc.longitude)
                            reverseGeocode(loc.latitude, loc.longitude)
                                ?.let { area -> action.put("area", area) }
                        }
                    }
                }
                if (finalAction?.optString("type") == "calendar_add") {
                    upsertPendingCalendarAction(finalAction, convKey, senderName)
                }
                val nowInApp = ProTxtAccessibilityService.activePackage == packageName
                // Always post the suggestion notification so it lands in pendingBubbles.
                // If we posted a loading bubble (!userInApp), we must update it with the real
                // reply — skipping postSuggestionNotification leaves it stuck on the loading
                // placeholder.
                // If the user was in the app the whole time (userInApp && nowInApp), post
                // silently (repost=true → PRIORITY_DEFAULT, no heads-up) so the bubble is
                // available the moment they leave the messaging app. Without this the suggestion
                // is discarded and no bubble ever appears after they close WhatsApp/Telegram.
                postSuggestionNotification(
                    primary, formal, brief,
                    replyPendingIntent, remoteInputKey, notifId, convKey, result.intent,
                    openChatIntent, latestMessage, detectedIntentsStr,
                    suggestedAction = finalAction, markAsReadPendingIntent = markAsReadPendingIntent,
                    repost = userInApp && nowInApp,
                )
                if (nowInApp) {
                    // Also cache for the overlay when user is currently in the app
                    cacheSuggestion(packageName, convKey, primary, formal, brief, finalAction?.toString())
                }
                // Notify the IME overlay — shows/refreshes strip if the app is in focus
                ProTxtAccessibilityService.onSuggestionReady?.invoke(packageName)
                // Update the Activity if it's already open showing the loading state.
                // The Activity nulls onReplyReady itself in its callback; we don't null
                // it here to avoid a race where we null it before the Activity registers.
                BubbleSuggestionActivity.onReplyReady[convKey]?.invoke(primary, formal, brief, finalAction)
                enqueuePendingContact(convKey, senderName, packageName)
            } catch (e: Exception) {
                android.util.Log.e("ProTxt", "worker exception: ${e.javaClass.simpleName}: ${e.message}")
                if (activeBubbles.contains(convKey)) {
                    postErrorNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, detectedIntentsStr, markAsReadPendingIntent)
                }
            } finally {
                jobDone.set(true)
            }
        }
        // Watchdog: if the job hasn't finished by the deadline, it's stuck on a blocking
        // call somewhere (e.g. GoogleAuthUtil.getToken() has no timeout of its own). Show
        // the error state instead of leaving the loading placeholder stuck forever. Must
        // check jobDone, not activeBubbles — activeBubbles stays true after a successful
        // suggestion too (until the user sends/dismisses it), so checking it here would
        // overwrite an already-successful suggestion once this deadline passes.
        scheduler.schedule({
            if (!jobDone.get()) {
                if (BuildConfig.DEBUG) android.util.Log.w("ProTxt", "worker timed out, showing error state")
                postErrorNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, detectedIntentsStr, markAsReadPendingIntent)
            }
        }, WORKER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    // Re-runs the worker call for a conversation currently showing the error state.
    // Reuses the PendingBubble cached by postErrorNotification — it carries everything
    // runWorkerJob needs (replyPendingIntent, remoteInputKey, etc.) without requiring
    // a second parallel cache.
    fun retry(convKey: String) {
        val cached = pendingBubbles[convKey] ?: return
        val packageName = convKey.substringBefore(":")
        postLoadingNotification(
            cached.notifId, convKey, cached.replyPendingIntent, cached.remoteInputKey,
            cached.openChatIntent, cached.message, cached.detectedIntents, cached.markAsReadPendingIntent,
        )
        runWorkerJob(
            convKey, cached.notifId, cached.message, cached.detectedIntents,
            cached.replyPendingIntent, cached.remoteInputKey, cached.openChatIntent,
            cached.markAsReadPendingIntent, packageName, userInApp = false,
        )
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap, reason: Int) {
        // Detect call end via in-call notification removal — no READ_PHONE_STATE needed.
        // CATEGORY_CALL covers standard dialers; DIALER_PACKAGES + FLAG_ONGOING_EVENT
        // is a fallback for OEMs that don't set the category correctly.
        if (sbn.packageName !in TARGET_PACKAGES) {
            val notif = sbn.notification
            val isCallEnd = notif?.category == Notification.CATEGORY_CALL ||
                (sbn.packageName in DIALER_PACKAGES &&
                    (notif?.flags ?: 0) and Notification.FLAG_ONGOING_EVENT != 0)
            if (isCallEnd && pendingBubbles.isNotEmpty()) {
                Handler(Looper.getMainLooper()).postDelayed({ repostPendingBubbles() }, 800L)
            }
            return
        }

        // Dismiss logic by reason code:
        //
        // REASON_CANCEL (2) / REASON_CANCEL_ALL (3): user explicitly swiped the WhatsApp
        //   notification away in the shade — deliberate acknowledgement, dismiss the bubble.
        //
        // REASON_CLICK (1): user tapped the notification to open the app — they are now
        //   reading the message but haven't replied yet. Keep the bubble alive; it's the
        //   only surface that lets them send a reply without switching back to WhatsApp.
        //   Reply detection happens in onNotificationPosted Gate 6 (outbound MessagingStyle
        //   update) or via AccessibilityService send-button detection.
        //
        // REASON_APP_CANCEL (8): the messaging app cancelled the notification programmatically
        //   (typically because the conversation came into focus inside the app). Same as
        //   REASON_CLICK — user is in the app reading, not necessarily replying. Keep bubble.
        //   A 10-minute auto-dismiss timeout prevents zombie bubbles if we never detect a reply.
        //
        // All other codes (REASON_APP_CANCEL_ALL, REASON_SNOOZED, etc.): conservative default
        //   is to dismiss so we don't accumulate stale bubbles on unusual lifecycle events.

        val extras = sbn.notification?.extras ?: return
        val convKey = buildConversationKey(sbn, extras)
        val isTracked = activeBubbles.contains(convKey) || pendingJobs.containsKey(convKey)

        when (reason) {
            REASON_CLICK, REASON_APP_CANCEL -> {
                // User opened the messaging app — keep the ConTxt bubble notification alive
                // (don't cancel it) so the suggested reply remains accessible without
                // switching back. Remove from activeBubbles so that a new incoming message
                // in the same conversation is treated as fresh and generates an updated
                // suggestion rather than being skipped by the active-bubble guard.
                lastOpenedTimestamp[sbn.packageName] = System.currentTimeMillis()
                if (isTracked) {
                    activeBubbles.remove(convKey)
                    // Schedule auto-dismiss keyed on pendingBubbles (not activeBubbles,
                    // which we just cleared) as the zombie-bubble safety net. Gate 6 and
                    // send-button detection clear pendingBubbles before this fires when a
                    // reply is confirmed.
                    scheduler.schedule({
                        if (pendingBubbles.containsKey(convKey)) {
                            if (BuildConfig.DEBUG) android.util.Log.d("ProTxt",
                                "auto-dismiss after timeout: $convKey")
                            val notifId = convKey.hashCode().and(0x7FFFFFFF)
                            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
                            activeBubbles.remove(convKey)
                            arrivalBuffer.remove(convKey)
                            pendingBubbles.remove(convKey)
                        }
                    }, 10L, TimeUnit.MINUTES)
                }
            }
            REASON_CANCEL, REASON_CANCEL_ALL -> {
                // User swiped the notification away in the shade — explicit dismissal.
                // Dismiss our bubble too.
                if (isTracked) {
                    val notifId = convKey.hashCode().and(0x7FFFFFFF)
                    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
                    activeBubbles.remove(convKey)
                    arrivalBuffer.remove(convKey)
                    pendingJobs[convKey]?.cancel(false)
                    pendingJobs.remove(convKey)
                }
            }
            else -> {
                // REASON_APP_CANCEL_ALL (9), REASON_SNOOZED (18), REASON_TIMEOUT (19), etc.
                // Conservatively dismiss to avoid stale bubbles on unusual lifecycle events.
                if (isTracked) {
                    val notifId = convKey.hashCode().and(0x7FFFFFFF)
                    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
                    activeBubbles.remove(convKey)
                    arrivalBuffer.remove(convKey)
                    pendingJobs[convKey]?.cancel(false)
                    pendingJobs.remove(convKey)
                }
            }
        }
    }

    private fun buildConversationKey(sbn: StatusBarNotification, extras: Bundle): String {
        val packageName = sbn.packageName
        val conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val isGroup = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        // Reverted 2026-06-16: tried keying on sbn.id instead of title to avoid the
        // same-name-contact collision, but on this device WhatsApp reuses small sbn.id
        // values (e.g. 11, then group:1) across unrelated conversations, which cross-
        // contaminated the message buffer/thread store between them. Title-based key is
        // back; the same-name collision is a rarer, lower-impact issue than that.
        // Key selection priority:
        // 1. Group + conversationTitle: WhatsApp/Telegram set EXTRA_CONVERSATION_TITLE to the
        //    actual group name (e.g. "Ski - Val d'isere") — stable, no sender suffix.
        // 2. title: for individual chats this is "WhatsApp: ContactName" — unique per contact.
        //    Also handles Instagram's isGroup-flapping case: both notifications from the same
        //    sbn.id end up with the same title → same convKey → no split.
        //    NOTE: Do NOT use conversationTitle for individuals — WhatsApp sets it to "WhatsApp"
        //    (the lockscreen-privacy placeholder) for ALL individual chats, which collapses every
        //    1:1 chat into the same convKey "com.whatsapp:WhatsApp".
        // 3. Fallback to conversationTitle alone, then sbn.id-based keys.
        val key = when {
            isGroup && conversationTitle != null -> conversationTitle
            title != null -> title
            conversationTitle != null -> conversationTitle
            isGroup -> "group:${sbn.id}"
            else -> "id:${sbn.id}"
        }
        if (BuildConfig.DEBUG) android.util.Log.d("ProTxt", "convKey=$packageName:[hashed]  isGroup=$isGroup  sbnId=${sbn.id}")
        return "$packageName:$key"
    }



    private fun shouldSkipGroupMessages(): Boolean =
        Prefs.main(this)
            .getBoolean("skip_group_messages", true)

    private fun extractConversationThread(extras: Bundle): List<Pair<String?, String>> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return emptyList()
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES) ?: return emptyList()
        return messages.mapNotNull { msg ->
            if (msg !is Bundle) return@mapNotNull null
            // MessagingStyle.Message bundles use "text" / "sender" as keys (not "android.text")
            val text = msg.getCharSequence("text")?.toString() ?: return@mapNotNull null
            val sender = msg.getCharSequence("sender")?.toString()
            Pair(sender, text)
        }
    }

    private data class EtaData(val duration: String, val distance: String, val routeSummary: String, val destinationLabel: String, val userLat: Double, val userLon: Double)

    // ── Intent / enrichment registry ──────────────────────────────────────────
    // Mirror of src/utils/intentDetector.ts — keep patterns in sync.
    // To add a new data source: add an intent key, list its enrichment(s),
    // implement a fetch function, and handle the key in buildEnrichments().

    private val ETA_PATTERNS = listOf(
        Regex("""\beta\b""", RegexOption.IGNORE_CASE),
        Regex("""when (will|are) you""", RegexOption.IGNORE_CASE),
        Regex("""how (long|far)""", RegexOption.IGNORE_CASE),
        Regex("""on (your|the) way""", RegexOption.IGNORE_CASE),
        Regex("""(leaving|left) yet""", RegexOption.IGNORE_CASE),
        Regex("""\b(arriving|arrive|arrival)\b""", RegexOption.IGNORE_CASE),
        Regex("""where are you""", RegexOption.IGNORE_CASE),
        Regex("""almost (here|there)""", RegexOption.IGNORE_CASE),
        Regex("""how (close|soon)""", RegexOption.IGNORE_CASE),
    )

    private val AVAILABILITY_PATTERNS = listOf(
        Regex("""\b(free|available|availability)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(busy|schedule|calendar)\b""", RegexOption.IGNORE_CASE),
        // "chat" and "call" alone are too broad (casual social use). Require scheduling context.
        Regex("""\b(meeting|catch.?up)\b""", RegexOption.IGNORE_CASE),
        // Day name alone is too noisy ("had a great Saturday"). Require scheduling context around it.
        Regex("""\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday) (morning|afternoon|evening|night|at \d|work[s]?)\b""", RegexOption.IGNORE_CASE),
        Regex("""(meet(?:\s+up)?|free|available|works?) (on |for )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bmeet[\s-]?up\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(this|next) (week|weekend|morning|afternoon|evening)\b""", RegexOption.IGNORE_CASE),
        Regex("""\btomorrow\b""", RegexOption.IGNORE_CASE),
        Regex("""\btonight\b""", RegexOption.IGNORE_CASE),
        Regex("""are you (around|up for|down for)""", RegexOption.IGNORE_CASE),
        // event-lookup: "when are you free/available/back?" — not just any "when is/are"
        Regex("""\bwhen (are you|do you|can you|will you)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bwhat (?:day|date|time) (?:is|are|works)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bwhat (?:is|are) the (?:date|day|time)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bwhat about (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bhow about (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b""", RegexOption.IGNORE_CASE),
        // Social plans imply scheduling: "dinner on Tuesday?", "Tuesday lunch?", "coffee Saturday"
        Regex("""\b(dinner|lunch|coffee|drinks|brunch|breakfast|supper)\s+(?:on\s+|for\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(dinner|lunch|coffee|drinks|brunch|breakfast|supper)\b""", RegexOption.IGNORE_CASE),
        // Calendar-check queries: questions that need calendar context to answer ("Is it Dan's bday soon?")
        Regex("""\b(birthday|bday|b-day)\b""", RegexOption.IGNORE_CASE),
        Regex("""\banniversary\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(appointment|appt)\b""", RegexOption.IGNORE_CASE),
        Regex("""\breminder\b""", RegexOption.IGNORE_CASE),
        Regex("""(coming up|any plans|what('?s| is) (on|happening)|anything (on|planned|scheduled))""", RegexOption.IGNORE_CASE),
        Regex("""\b(event|events)\b.{0,20}\b(this|next|any|upcoming|soon)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(this|next|any|upcoming|soon)\b.{0,20}\b(event|events)\b""", RegexOption.IGNORE_CASE),
    )

    private val LOCATION_SHARE_PATTERNS = listOf(
        Regex("""(share|send|drop).{0,20}(your |a )?(location|pin|coordinates)""", RegexOption.IGNORE_CASE),
        Regex("""(your |a )(location|pin|coordinates)""", RegexOption.IGNORE_CASE),
        Regex("""share where (you are|you're)""", RegexOption.IGNORE_CASE),
        Regex("""where are you\b""", RegexOption.IGNORE_CASE),
        Regex("""where r u\b""", RegexOption.IGNORE_CASE),
        Regex("""where you at\b""", RegexOption.IGNORE_CASE),
        Regex("""where are you right now""", RegexOption.IGNORE_CASE),
        Regex("""what('?s| is) your location""", RegexOption.IGNORE_CASE),
        Regex("""(location|pin) (please|pls)\b""", RegexOption.IGNORE_CASE),
    )

    // Patterns that fire when the OTHER person has shared their location — a Maps link,
    // short URL, native WhatsApp/Telegram pin, Apple Maps link, or raw GPS coordinates.
    private val INCOMING_LOCATION_PATTERNS = listOf(
        Regex("""maps\.(google|apple)\.com""", RegexOption.IGNORE_CASE),
        Regex("""maps\.app\.goo\.gl""", RegexOption.IGNORE_CASE),
        Regex("""goo\.gl/maps""", RegexOption.IGNORE_CASE),
        Regex("""📍"""),
        // Raw GPS coordinates with enough decimals to look intentional (not prose numbers)
        Regex("""(-?\d{1,3}\.\d{5,})\s*,\s*(-?\d{1,3}\.\d{5,})"""),
    )

    private val INTENT_ENRICHMENTS = mapOf(
        "eta"               to listOf("maps"),
        "availability"      to listOf("calendar"),
        "location_share"    to listOf("location_coords"),
        "incoming_location" to listOf("incoming_location", "maps"),
        "other"             to listOf<String>(),
    )

    private fun detectIntents(message: String): List<String> {
        val intents = mutableListOf<String>()
        if (ETA_PATTERNS.any { it.containsMatchIn(message) }) intents.add("eta")
        if (AVAILABILITY_PATTERNS.any { it.containsMatchIn(message) }) intents.add("availability")
        if (LOCATION_SHARE_PATTERNS.any { it.containsMatchIn(message) }) intents.add("location_share")
        if (INCOMING_LOCATION_PATTERNS.any { it.containsMatchIn(message) }) intents.add("incoming_location")
        return intents.ifEmpty { listOf("other") }
    }

    // Extracts lat/lng from a full Google or Apple Maps URL. Returns null for short URLs.
    private fun extractMapsCoordinates(text: String): Pair<Double, Double>? {
        val patterns = listOf(
            Regex("""@(-?\d+\.\d+),(-?\d+\.\d+)"""),                    // /place/Name/@lat,lng,zoom
            Regex("""[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)"""),               // ?q=lat,lng
            Regex("""[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)"""),              // Apple Maps ?ll=lat,lng
            Regex("""(-?\d{1,3}\.\d{5,})\s*,\s*(-?\d{1,3}\.\d{5,})"""), // raw coords
        )
        for (pattern in patterns) {
            val m = pattern.find(text) ?: continue
            val lat = m.groupValues[1].toDoubleOrNull() ?: continue
            val lon = m.groupValues[2].toDoubleOrNull() ?: continue
            if (lat in -90.0..90.0 && lon in -180.0..180.0) return Pair(lat, lon)
        }
        return null
    }

    // Extracts a Maps short URL that the worker must resolve to get coordinates.
    private fun extractShortMapsUrl(text: String): String? =
        Regex("""https?://(?:maps\.app\.goo\.gl|goo\.gl/maps)/\S+""").find(text)?.value

    private fun requiredEnrichments(message: String, intentsStr: String? = null): List<String> {
        // Use the already-resolved intents (which include inherited context) when available,
        // so follow-up messages like "ok cool" still get maps/calendar enrichments.
        val intents = if (!intentsStr.isNullOrEmpty() && intentsStr != "other")
            intentsStr.split(",").map { it.trim() }
        else
            detectIntents(message)
        return intents.flatMap { INTENT_ENRICHMENTS[it] ?: emptyList() }.distinct()
    }

    private fun buildEnrichments(message: String, thread: List<Pair<String?, String>> = emptyList(), convKey: String? = null, intentsStr: String? = null): JSONObject {
        val enrichments = JSONObject()
        for (key in requiredEnrichments(message, intentsStr)) {
            when (key) {
                "maps" -> {
                    // Prefer coords from the incoming_location enrichment (already resolved,
                    // including short URLs the worker followed). Fall back to direct extraction.
                    val incomingCoords: Pair<Double, Double>? = run {
                        val fromEnrichment = enrichments.optJSONObject("incoming_location")
                            ?.let { loc ->
                                val lat = loc.optDouble("lat", Double.NaN)
                                val lon = loc.optDouble("lon", Double.NaN)
                                if (!lat.isNaN() && !lon.isNaN()) Pair(lat, lon) else null
                            }
                        if (fromEnrichment != null) return@run fromEnrichment
                        val searchText = listOf(message) + thread.map { it.second }
                        searchText.firstNotNullOfOrNull { extractMapsCoordinates(it) }
                    }
                    val eta: EtaData? = if (incomingCoords != null) {
                        val label = enrichments.optJSONObject("incoming_location")
                            ?.optString("placeLabel")?.ifEmpty { null }
                            ?: reverseGeocode(incomingCoords.first, incomingCoords.second)
                            ?: "their location"
                        fetchEtaToCoords(incomingCoords.first, incomingCoords.second, label)
                    } else {
                        // Search latest message first, then fall back to recent thread history
                        // (last 10 messages, within 48 h) so stale destinations from old
                        // conversations don't pollute the ETA. Uses newest-first ordering so
                        // the most-recent location mention wins.
                        val etaThread = convKey?.let {
                            store.getEtaSearchThread(it, maxCount = 10)
                        } ?: thread.takeLast(10).asReversed()
                        fetchEtaData(message) ?: etaThread
                            .firstNotNullOfOrNull { (_, text) -> fetchEtaData(text) }
                    }
                    if (eta != null) {
                        enrichments.put("maps", JSONObject().apply {
                            put("duration", eta.duration)
                            put("distance", eta.distance)
                            put("routeSummary", eta.routeSummary)
                            put("destinationLabel", eta.destinationLabel)
                            put("userLat", eta.userLat)
                            put("userLon", eta.userLon)
                        })
                    } else {
                        // No extractable destination — pass current location name so Claude
                        // can at least say where the user is rather than guessing.
                        getCurrentLocation()?.let { loc ->
                            reverseGeocode(loc.latitude, loc.longitude)?.let { area ->
                                enrichments.put("maps", JSONObject().apply {
                                    put("currentLocation", area)
                                })
                            }
                        }
                    }
                }
                "calendar" -> fetchCalendarData(message)?.let { cal ->
                    enrichments.put("calendar", cal)
                }
                "location_coords" -> getCurrentLocation()?.let { loc ->
                    enrichments.put("location_coords", JSONObject().apply {
                        put("lat", loc.latitude)
                        put("lon", loc.longitude)
                    })
                }
                "incoming_location" -> {
                    val searchText = listOf(message) + thread.map { it.second }
                    val obj = JSONObject()
                    var resolved = false
                    for (t in searchText) {
                        val coords = extractMapsCoordinates(t)
                        if (coords != null) {
                            obj.put("lat", coords.first)
                            obj.put("lon", coords.second)
                            reverseGeocode(coords.first, coords.second)
                                ?.let { obj.put("placeLabel", it) }
                            resolved = true
                            break
                        }
                    }
                    if (!resolved) {
                        // Short URL — pass it to the worker for redirect resolution
                        val shortUrl = searchText.firstNotNullOfOrNull { extractShortMapsUrl(it) }
                        if (shortUrl != null) obj.put("shortUrl", shortUrl)
                        else obj.put("nativePin", true) // WhatsApp 📍 or Telegram pin
                    }
                    enrichments.put("incoming_location", obj)
                }
            }
        }
        detectEmotionalCharge(message, thread)?.let { enrichments.put("emotion", it) }
        return enrichments
    }

    private fun detectEmotionalCharge(message: String, thread: List<Pair<String?, String>>): JSONObject? {
        // Combine the current message with the last 2 inbound messages for better signal on
        // short replies like "k" that only make sense in context.
        val recentInbound = thread.takeLast(3)
            .filter { (sender, _) -> sender != null }
            .map { it.second }
        val corpus = (recentInbound + message).joinToString(" ")

        data class Signal(val emotion: String, val patterns: List<Regex>)

        val highConfidence = listOf(
            Signal("anger", listOf(
                Regex("""!{2,}"""),
                Regex("""\b(hate|furious|disgusting|unbelievable|ridiculous|pathetic|useless|terrible|awful|pissed)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(can'?t believe|so done|fed up|had enough|not okay|not ok|done with)\b""", RegexOption.IGNORE_CASE),
                Regex("""(?<![a-z])[A-Z]{4,}(?![a-z])"""),  // SHOUTING
            )),
            Signal("urgency", listOf(
                Regex("""\b(urgent|asap|emergency|right now|immediately|hurry|need you now)\b""", RegexOption.IGNORE_CASE),
                Regex("""\?{2,}"""),
            )),
            Signal("anxiety", listOf(
                Regex("""\b(worried|scared|anxious|nervous|panicking|freaking out|stressed|terrified)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(are you okay|you alright|is everything ok|what happened|hope you'?re ok)\b""", RegexOption.IGNORE_CASE),
            )),
        )

        val lowConfidence = listOf(
            Signal("frustration", listOf(
                Regex("""\b(ugh|sigh|smh|ffs|seriously|really\?)\b""", RegexOption.IGNORE_CASE),
                Regex("""\b(tired of|sick of|again\?|always|never listens)\b""", RegexOption.IGNORE_CASE),
            )),
            Signal("passive_agg", listOf(
                Regex("""\b(fine|whatever|k|sure|ok)\b\.?\s*$""", RegexOption.IGNORE_CASE),
                Regex("""\.{3,}$"""),  // trailing ellipsis on short message
            )),
        )

        // High-confidence: check full corpus (message + recent thread)
        for ((emotion, patterns) in highConfidence) {
            if (patterns.any { it.containsMatchIn(corpus) }) {
                return JSONObject().apply {
                    put("emotion", emotion)
                    put("confidence", "high")
                }
            }
        }

        // Low-confidence: only trigger on short messages (< 30 chars) to reduce false positives
        if (message.trim().length < 30) {
            for ((emotion, patterns) in lowConfidence) {
                if (patterns.any { it.containsMatchIn(message) }) {
                    return JSONObject().apply {
                        put("emotion", emotion)
                        put("confidence", "low")
                    }
                }
            }
        }

        return null
    }

    fun getLastLocation(): android.location.Location? = lastLocation

    private fun extractEventKeyword(message: String): String? {
        val patterns = listOf(
            Regex("""when (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""what (?:day|time|date) (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""what (?:is|are) the (?:day|time|date) (?:of|for)(?: my| the| our)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            Regex("""remind me (?:about|of)(?: my| the)? (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { re ->
            re.find(message)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.length > 1 && it.length < 50 }
        }
    }

    private fun extractSearchTerm(keyword: String): String {
        val stopwords = setOf("my", "the", "a", "an", "our", "your", "his", "her", "their", "its")
        val words = keyword.split(Regex("\\s+"))
        val word = words.firstOrNull { !stopwords.contains(it.lowercase().replace(Regex("'s$"), "")) } ?: words[0]
        return word.replace(Regex("'s$", RegexOption.IGNORE_CASE), "")
    }

    private fun calendarApiCall(token: String, timeMin: String, timeMax: String, maxResults: Int, q: String? = null): JSONArray {
        val qParam = if (q != null) "&q=${URLEncoder.encode(q, "UTF-8")}" else ""
        val conn = URL("https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$timeMin&timeMax=$timeMax&singleEvents=true&orderBy=startTime&maxResults=$maxResults$qParam")
            .openConnection() as HttpURLConnection
        conn.connectTimeout = 8_000
        conn.readTimeout = 8_000
        conn.setRequestProperty("Authorization", "Bearer $token")
        return try {
            JSONObject(conn.inputStream.bufferedReader().readText()).optJSONArray("items") ?: JSONArray()
        } finally {
            conn.disconnect()
        }
    }

    // True when the message is clearly asking about a past event ("last week", "did you make it",
    // "how was the concert last Friday"). False for future/availability questions.
    private fun isPastTemporalQuery(message: String): Boolean = listOf(
        Regex("""\blast\s+(week|month|friday|thursday|wednesday|tuesday|monday|weekend|night)\b""", RegexOption.IGNORE_CASE),
        Regex("""\byesterday\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(did you|were you|was it|how was|how did|did it go)\b""", RegexOption.IGNORE_CASE),
    ).any { it.containsMatchIn(message) }

    private fun fetchCalendarData(message: String): JSONObject? {
        val keyword = extractEventKeyword(message)
        val isPast = isPastTemporalQuery(message)
        return try {
            val account = GoogleSignIn.getLastSignedInAccount(this) ?: return null
            val token = GoogleAuthUtil.getToken(
                this,
                account.account ?: return null,
                "oauth2:https://www.googleapis.com/auth/calendar.readonly"
            )
            val now = Instant.now()
            // Look back only when the message clearly refers to a past event.
            // Default to now so "Friday" means the upcoming Friday, not last Friday.
            val windowStart = if (isPast) now.minus(14, ChronoUnit.DAYS) else now
            val windowEnd = if (keyword != null) now.plus(90, ChronoUnit.DAYS) else now.plus(7, ChronoUnit.DAYS)
            val timeMin = URLEncoder.encode(OffsetDateTime.ofInstant(windowStart, ZoneOffset.UTC).toString(), "UTF-8")
            val timeMax = URLEncoder.encode(OffsetDateTime.ofInstant(windowEnd, ZoneOffset.UTC).toString(), "UTF-8")

            val items = if (keyword != null) {
                val searchTerm = extractSearchTerm(keyword)
                val first = calendarApiCall(token, timeMin, timeMax, 10, searchTerm)
                if (first.length() > 0) first else calendarApiCall(token, timeMin, timeMax, 30)
            } else {
                calendarApiCall(token, timeMin, timeMax, 50)
            }
            val events = JSONArray()
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val start = item.optJSONObject("start")
                val end = item.optJSONObject("end")
                val allDay = start?.has("date") == true && start.has("dateTime").not()
                events.put(JSONObject().apply {
                    put("summary", item.optString("summary", "Untitled"))
                    put("start", start?.optString(if (allDay) "date" else "dateTime", "") ?: "")
                    put("end", end?.optString(if (allDay) "date" else "dateTime", "") ?: "")
                    put("allDay", allDay)
                })
            }
            JSONObject().apply {
                put("events", events)
                put("windowStart", OffsetDateTime.ofInstant(windowStart, ZoneOffset.UTC).toString())
                put("windowEnd", OffsetDateTime.ofInstant(windowEnd, ZoneOffset.UTC).toString())
            }
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) android.util.Log.w("ProTxtBgService", "Calendar fetch failed: ${e.message}")
            null
        }
    }

    private fun isEtaIntent(message: String): Boolean = ETA_PATTERNS.any { it.containsMatchIn(message) }

    private fun reverseGeocode(lat: Double, lng: Double): String? = try {
        val geocoder = android.location.Geocoder(this, java.util.Locale.getDefault())
        @Suppress("DEPRECATION")
        geocoder.getFromLocation(lat, lng, 1)
            ?.firstOrNull()
            ?.let { it.subLocality ?: it.locality ?: it.thoroughfare }
    } catch (_: Exception) { null }

    // Returns the most recent live location. If lastLocation is fresh (< 30s) use it directly.
    // Otherwise request a one-shot update and block the calling thread up to 5s for a new fix.
    // Falls back to lastLocation (any age) if no fresh fix arrives in time.
    // Called from worker threads only — never call from main thread.
    private fun getCurrentLocation(): Location? {
        val now = System.currentTimeMillis()
        lastLocation?.let { if (now - it.time < 30_000) return it }

        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return lastLocation
        val latch = java.util.concurrent.CountDownLatch(1)

        val oneShotListener = object : android.location.LocationListener {
            override fun onLocationChanged(loc: android.location.Location) {
                lastLocation = loc
                latch.countDown()
                try { lm.removeUpdates(this) } catch (_: Exception) {}
            }
            @Deprecated("") override fun onStatusChanged(p: String?, s: Int, e: android.os.Bundle?) {}
        }

        try {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).forEach { provider ->
                if (lm.isProviderEnabled(provider))
                    @Suppress("MissingPermission")
                    lm.requestLocationUpdates(provider, 0L, 0f, oneShotListener, mainLooper)
            }
        } catch (_: SecurityException) { return lastLocation }

        latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        try { lm.removeUpdates(oneShotListener) } catch (_: Exception) {}
        return lastLocation
    }

    // Words that look like destinations when extracted but are not routable place names.
    private val DESTINATION_NOISE = setOf(
        "you", "us", "me", "them", "here", "there", "it", "that", "this",
        "the area", "your place",
    )

    private val HOME_KEYWORDS = setOf(
        "home", "my place", "my house", "my flat", "my apartment", "my home",
    )

    private fun extractDestination(message: String): String? {
        val patterns = listOf(
            Regex("""(?:how far|far) (?:are you |is it )?(?:from|to) (.+?)(?:\?|,|$)""", RegexOption.IGNORE_CASE),
            Regex("""(?:near|at|by|in|outside|around) (.+?)(?:\?|,|\. | are | is | and | - |$)""", RegexOption.IGNORE_CASE),
            Regex("""distance (?:from|to) (.+?)(?:\?|,|$)""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { re ->
            val raw = re.find(message)?.groupValues?.getOrNull(1)?.trim() ?: return@firstNotNullOfOrNull null
            // Reject noise words and overly long / short extractions
            if (raw.length < 2 || raw.length > 60) return@firstNotNullOfOrNull null
            if (DESTINATION_NOISE.any { raw.equals(it, ignoreCase = true) }) return@firstNotNullOfOrNull null
            // Reject if the extracted text reads like a sentence fragment (contains a verb phrase)
            if (Regex("""\b(are|is|do|will|can|have|going)\b""", RegexOption.IGNORE_CASE).containsMatchIn(raw)) return@firstNotNullOfOrNull null
            raw
        }
    }

    private fun getEnrichmentPref(enrichment: String, key: String, default: String): String {
        val prefs = Prefs.main(this)
        return try {
            JSONObject(prefs.getString("enrichment_prefs", "{}") ?: "{}")
                .optJSONObject(enrichment)?.optString(key)?.ifEmpty { null } ?: default
        } catch (_: Exception) { default }
    }

    private fun fetchEtaData(message: String): EtaData? {
        val raw = extractDestination(message) ?: return null
        if (raw.lowercase().trim() in HOME_KEYWORDS) {
            val prefs = Prefs.main(this)
            if (!prefs.contains("home_lat")) return null
            val lat = prefs.getFloat("home_lat", 0f).toDouble()
            val lon = prefs.getFloat("home_lon", 0f).toDouble()
            return fetchEtaToCoords(lat, lon, "home")
        }
        return fetchEtaToDestination(raw, raw)
    }

    private fun fetchEtaToCoords(lat: Double, lon: Double, label: String): EtaData? =
        fetchEtaToDestination("$lat,$lon", label)

    private fun fetchEtaToDestination(destination: String, label: String): EtaData? {
        val apiKey = BuildConfig.GOOGLE_MAPS_API_KEY.ifEmpty {
            android.util.Log.e("ProTxt", "ETA: no Maps API key")
            return null
        }
        val location = getCurrentLocation()
        if (location == null) {
            android.util.Log.e("ProTxt", "ETA: no GPS location available")
            return null
        }
        val origin = "${location.latitude},${location.longitude}"
        val mode = getEnrichmentPref("maps", "transportMode", "driving")
        val params = buildString {
            append("origin=${encode(origin)}&destination=${encode(destination)}&mode=$mode")
            if (mode == "driving") append("&departure_time=now")
            append("&key=$apiKey")
        }
        return try {
            val conn = URL("https://maps.googleapis.com/maps/api/directions/json?$params")
                .openConnection() as HttpURLConnection
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            val json = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val obj = JSONObject(json)
            val status = obj.optString("status")
            if (status != "OK") {
                android.util.Log.e("ProTxt", "ETA: Directions API status=$status dest=\"$destination\"")
                return null
            }
            val leg = obj.getJSONArray("routes").getJSONObject(0).getJSONArray("legs").getJSONObject(0)
            val duration = (leg.optJSONObject("duration_in_traffic") ?: leg.getJSONObject("duration"))
                .getString("text")
            val distance = leg.getJSONObject("distance").getString("text")
            val route = obj.getJSONArray("routes").getJSONObject(0).optString("summary", "")
            android.util.Log.d("ProTxt", "ETA: $duration to \"$label\" via $route")
            EtaData(duration, distance, route, label, location.latitude, location.longitude)
        } catch (e: Exception) {
            android.util.Log.e("ProTxt", "ETA: exception for dest=\"$destination\": ${e.message}")
            null
        }
    }

    private fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = android.provider.Settings.Secure.getString(
            contentResolver, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.contains("$packageName/com.contextreply.app.ProTxtAccessibilityService")
    }

    // Android can't render a bubble over the lock screen — a bubble-eligible notification
    // posted while locked falls back to a normal shade entry, then gets converted into a
    // bubble (shade entry disappears, bubble appears) once restoreBubblesReceiver fires on
    // ACTION_USER_PRESENT. That conversion is what shows as a visible flash. Skip the post
    // entirely while locked; pendingBubbles still gets cached below so the unlock receiver's
    // repostPendingBubbles() does the first real, non-flashing post once the device is unlocked.
    private fun isDeviceLocked(): Boolean =
        (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isKeyguardLocked == true

    private fun postLoadingNotification(
        notifId: Int,
        convKey: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        openChatIntent: PendingIntent?,
        message: String,
        detectedIntents: String,
        markAsReadPendingIntent: PendingIntent? = null,
        repost: Boolean = false,
    ) {
        ReplySendReceiver.pendingReplyIntents[notifId] = replyPendingIntent
        if (markAsReadPendingIntent != null) ReplySendReceiver.pendingMarkReadIntents[notifId] = markAsReadPendingIntent
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val dismissIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_DISMISS
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
            putExtra(EXTRA_REPLY_TEXT, "")
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, notifId + 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val contactLabel = convKey.substringAfter(":").let { key ->
            when {
                key.startsWith("group:") -> "Group chat"
                key.startsWith("id:") -> null
                else -> stripAppPrefix(key).take(30)
            }
        }
        val priority = if (repost) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH
        val builder = NotificationCompat.Builder(this, if (repost) CHANNEL_SILENT_ID else CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(if (contactLabel != null) "↩ $contactLabel" else "Drafting reply…")
            .setContentText("Drafting reply…")
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(priority)
            .setGroup("contextreply_suggestions")
        BubbleHelper.attach(
            this, builder,
            LOADING_PLACEHOLDER, null, null,
            remoteInputKey, notifId, convKey, null,
            openChatIntent, message, detectedIntents,
            preferredToneForContact(convKey),
            contactMatchJson = contactMatchJson(convKey),
        )
        if (!isDeviceLocked()) nm.notify(notifId, builder.build())
        // Store so the bubble can be re-promoted after screen unlock or call end.
        // postSuggestionNotification will overwrite this entry when the reply is ready.
        pendingBubbles[convKey] = PendingBubble(
            LOADING_PLACEHOLDER, null, null, replyPendingIntent, remoteInputKey,
            notifId, convKey, null, openChatIntent, message, detectedIntents, null,
            markAsReadPendingIntent,
        )
    }

    // Worker call failed, timed out, or produced no usable reply — show a visible
    // error state with a Retry action instead of silently dropping the loading bubble.
    // Keeps a PendingBubble cached (unlike the silent-cancel it replaces) so retry()
    // and the unlock/send/call-end repost mechanisms have everything needed to either
    // re-run the worker call or re-show this same error state.
    private fun postErrorNotification(
        notifId: Int,
        convKey: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        openChatIntent: PendingIntent?,
        message: String,
        detectedIntents: String,
        markAsReadPendingIntent: PendingIntent? = null,
        repost: Boolean = false,
    ) {
        ReplySendReceiver.pendingReplyIntents[notifId] = replyPendingIntent
        if (markAsReadPendingIntent != null) ReplySendReceiver.pendingMarkReadIntents[notifId] = markAsReadPendingIntent
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val dismissIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_DISMISS
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
            putExtra(EXTRA_REPLY_TEXT, "")
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, notifId + 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val retryIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_RETRY
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
        }
        val retryPi = PendingIntent.getBroadcast(
            this, notifId + 3, retryIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val contactLabel = convKey.substringAfter(":").let { key ->
            when {
                key.startsWith("group:") -> "Group chat"
                key.startsWith("id:") -> null
                else -> stripAppPrefix(key).take(30)
            }
        }
        val builder = NotificationCompat.Builder(this, if (repost) CHANNEL_SILENT_ID else CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(if (contactLabel != null) "↩ $contactLabel" else "Couldn't generate a reply")
            .setContentText("Couldn't generate a reply")
            .addAction(android.R.drawable.ic_menu_revert, "Retry", retryPi)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(if (repost) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setGroup("contextreply_suggestions")
        BubbleHelper.attach(
            this, builder,
            ERROR_PLACEHOLDER, null, null,
            remoteInputKey, notifId, convKey, null,
            openChatIntent, message, detectedIntents,
            preferredToneForContact(convKey),
            contactMatchJson = contactMatchJson(convKey),
        )
        if (!isDeviceLocked()) nm.notify(notifId, builder.build())
        pendingBubbles[convKey] = PendingBubble(
            ERROR_PLACEHOLDER, null, null, replyPendingIntent, remoteInputKey,
            notifId, convKey, null, openChatIntent, message, detectedIntents, null,
            markAsReadPendingIntent,
        )
    }

    private fun preferredToneForContact(convKey: String): String? =
        confirmedTone(convKey) ?: Prefs.main(this).getString("default_tone", null)

    // Returns the preferred tone for a sender the user has already confirmed,
    // by looking up their contactId in confirmed_identities and then the tone in contact_cache.
    private fun confirmedTone(convKey: String): String? {
        val prefs = Prefs.main(this)
        val confirmed = try {
            JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
        } catch (_: Exception) { return null }
        val contactId = confirmed.optString(convKey).ifEmpty { return null }
        val cache = try {
            JSONArray(prefs.getString("contact_cache", "[]") ?: "[]")
        } catch (_: Exception) { return null }
        for (i in 0 until cache.length()) {
            val obj = cache.optJSONObject(i) ?: continue
            if (obj.optString("id") == contactId) return obj.optString("preferred_tone").ifEmpty { null }
        }
        return null
    }

    // Returns a JSON blob for a fuzzy-matched contact that hasn't been confirmed yet,
    // or null if the sender is already confirmed or no match found.
    // Includes a `candidates` array of up to 3 near-matches for the disambiguation picker.
    // Includes `crossApp: true` when the match would link two different app packages —
    // those are never auto-confirmed regardless of confidence; the user must approve.
    private fun contactMatchJson(convKey: String): String? {
        val prefs = Prefs.main(this)
        val confirmed = try {
            JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
        } catch (_: Exception) { JSONObject() }
        if (confirmed.has(convKey)) return null  // already confirmed, no banner needed
        val senderName = stripAppPrefix(convKey.substringAfter(":"))

        // Phone anchor: resolve raw numbers via PhoneLookup before fuzzy name matching.
        val phoneMatch = ContactMatcher.bestMatchByPhone(this, senderName)
        if (phoneMatch != null) {
            val (crossApp, srcPkg) = crossAppLink(phoneMatch.contactId, convKey, confirmed)
            if (!crossApp) {
                confirmed.put(convKey, phoneMatch.contactId)
                prefs.edit().putString("confirmed_identities", confirmed.toString()).apply()
                return null
            }
            return JSONObject().apply {
                put("contactId",   phoneMatch.contactId)
                put("displayName", phoneMatch.displayName)
                put("preferredTone", phoneMatch.preferredTone ?: "")
                put("confidence",  1.0)
                put("crossApp", true)
                put("crossAppSourceLabel", appLabel(srcPkg))
                put("candidates",  JSONArray())
            }.toString()
        }

        val candidates = ContactMatcher.bestMatches(this, senderName, 3)
        val primary = candidates.firstOrNull() ?: run {
            // No contact found anywhere — auto-register so the banner never repeats.
            val autoId = "auto:${senderName.lowercase().replace(Regex("[^a-z0-9]"), "_").take(40)}"
            confirmed.put(convKey, autoId)
            prefs.edit().putString("confirmed_identities", confirmed.toString()).apply()
            return null
        }

        fun candidatesJson() = JSONArray().also { arr ->
            for (c in candidates) arr.put(JSONObject().apply {
                put("contactId",    c.contactId)
                put("displayName",  c.displayName)
                put("preferredTone", c.preferredTone ?: "")
                put("confidence",   c.confidence)
            })
        }

        // High-confidence name match — auto-confirm unless it crosses app boundaries.
        if (primary.confidence >= ContactMatcher.AUTO_APPLY) {
            val (crossApp, srcPkg) = crossAppLink(primary.contactId, convKey, confirmed)
            if (!crossApp) {
                confirmed.put(convKey, primary.contactId)
                prefs.edit().putString("confirmed_identities", confirmed.toString()).apply()
                return null
            }
            return JSONObject().apply {
                put("contactId",   primary.contactId)
                put("displayName", primary.displayName)
                put("preferredTone", primary.preferredTone ?: "")
                put("confidence",  primary.confidence)
                put("crossApp", true)
                put("crossAppSourceLabel", appLabel(srcPkg))
                put("candidates",  candidatesJson())
            }.toString()
        }

        // Medium confidence (0.70–0.88) — always show banner; add crossApp flag if applicable.
        val (crossApp, srcPkg) = crossAppLink(primary.contactId, convKey, confirmed)
        return JSONObject().apply {
            put("contactId",   primary.contactId)
            put("displayName", primary.displayName)
            put("preferredTone", primary.preferredTone ?: "")
            put("confidence",  primary.confidence)
            if (crossApp) { put("crossApp", true); put("crossAppSourceLabel", appLabel(srcPkg)) }
            put("candidates",  candidatesJson())
        }.toString()
    }

    // Returns (true, sourcePkg) when contactId is already linked from a different package.
    // Synthetic auto:/sep: IDs are per-sender and never constitute a cross-app link.
    private fun crossAppLink(contactId: String, currentConvKey: String, confirmed: JSONObject): Pair<Boolean, String> {
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

    private fun postSuggestionNotification(
        replyText: String,
        formalText: String?,
        briefText: String?,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        notifId: Int,
        convKey: String,
        intent: String? = null,
        openChatIntent: PendingIntent? = null,
        message: String = "",
        detectedIntents: String = "",
        suggestedAction: org.json.JSONObject? = null,
        markAsReadPendingIntent: PendingIntent? = null,
        repost: Boolean = false,
    ) {
        val preferredTone = preferredToneForContact(convKey)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val sendIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_SEND
            putExtra(EXTRA_REPLY_TEXT, replyText)
            putExtra(EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
            if (intent != null) putExtra(EXTRA_INTENT, intent)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val sendPi = PendingIntent.getBroadcast(this, notifId, sendIntent, flags)

        ReplySendReceiver.pendingReplyIntents[notifId] = replyPendingIntent
        if (markAsReadPendingIntent != null) ReplySendReceiver.pendingMarkReadIntents[notifId] = markAsReadPendingIntent

        val copyIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_COPY
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
            putExtra(EXTRA_REPLY_TEXT, replyText)
            if (intent != null) putExtra(EXTRA_INTENT, intent)
        }
        val copyPi = PendingIntent.getBroadcast(
            this, notifId + 1, copyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Store all suggestion tones for AccessibilityService overlay + bubble
        val packageName = convKey.substringBefore(":")
        Prefs.main(this).edit()
            .putString("last_suggestion_$packageName", replyText)
            .putString("last_suggestion_formal_$packageName", formalText ?: "")
            .putString("last_suggestion_brief_$packageName", briefText ?: "")
            .putLong("last_suggestion_ts_$packageName", System.currentTimeMillis())
            .putString("last_suggestion_conv_$packageName", convKey)
            .apply()

        val contactLabel = convKey.substringAfter(":").let { key ->
            when {
                key.startsWith("group:") -> "Group chat"
                key.startsWith("id:") -> null
                else -> stripAppPrefix(key).take(30)
            }
        }

        // Build expanded text: each tone on its own line so the user can read all
        // variants from the shade and pick the one they want to send.
        val availableTones = buildList {
            add(Triple("Casual", replyText, notifId))
            if (!formalText.isNullOrEmpty()) add(Triple("Formal", formalText!!, notifId + 3))
            if (!briefText.isNullOrEmpty())  add(Triple("Brief",  briefText!!,  notifId + 4))
        }
        // Quick-reply choices for Android Auto — one CharSequence per available tone.
        // Shown as tappable chips in the car dashboard reply screen.
        val autoChoices: Array<CharSequence> = availableTones
            .map { (_, text, _) -> text as CharSequence }
            .toTypedArray()

        val builder = NotificationCompat.Builder(this, if (repost) CHANNEL_SILENT_ID else CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(if (contactLabel != null) "↩ $contactLabel" else "Suggested reply")
            .setContentText(replyText)
            .setPriority(if (repost) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setGroup("contextreply_suggestions")

        // Auto/WearOS reply action — MUST be FLAG_MUTABLE so the system can insert the
        // user's chosen text as a RemoteInput result before firing the broadcast.
        // Uses a distinct request code (notifId+5) so FLAG_UPDATE_CURRENT on the tone
        // actions below doesn't clobber this PendingIntent.
        val autoReplyPi = PendingIntent.getBroadcast(
            this, notifId + 5, sendIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        val autoRemoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY)
            .setLabel(replyText.take(60))
            .setChoices(autoChoices)
            .build()
        builder.addAction(
            NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "Reply", autoReplyPi)
                .addRemoteInput(autoRemoteInput)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .build()
        )

        // Per-tone send actions for phone notification shade (one tap → sends that variant).
        if (availableTones.size == 1) {
            builder.addAction(android.R.drawable.ic_menu_share, "Copy", copyPi)
        } else {
            availableTones.take(3).forEach { (label, text, reqCode) ->
                val toneIntent = Intent(this, ReplySendReceiver::class.java).apply {
                    action = ACTION_SEND
                    putExtra(EXTRA_REPLY_TEXT, text)
                    putExtra(EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
                    putExtra(EXTRA_NOTIF_ID, notifId)
                    putExtra(EXTRA_CONV_KEY, convKey)
                    if (intent != null) putExtra(EXTRA_INTENT, intent)
                    putExtra(EXTRA_TONE_SELECTED, label.lowercase())
                }
                val tonePi = PendingIntent.getBroadcast(this, reqCode, toneIntent, flags)
                builder.addAction(NotificationCompat.Action.Builder(
                    android.R.drawable.ic_menu_send, "$label ↩", tonePi
                ).build())
            }
        }

        // Action button (calendar, maps, etc.) when Claude detected a structured action
        if (suggestedAction != null) {
            val actionType  = suggestedAction.optString("type")
            val actionLabel = suggestedAction.optString("label").ifEmpty { null }
            val actionBroadcast = when (actionType) {
                "calendar_add" -> ActionReceiver.ACTION_CALENDAR_ADD
                "maps_open"    -> ActionReceiver.ACTION_MAPS_OPEN
                else           -> null
            }
            if (actionBroadcast != null && actionLabel != null) {
                val actionIntent = Intent(this, ActionReceiver::class.java).apply {
                    this.action = actionBroadcast
                    suggestedAction.optString("title").ifEmpty { null }?.let { putExtra(ActionReceiver.EXTRA_TITLE, it) }
                    suggestedAction.optString("datetime").ifEmpty { null }?.let { putExtra(ActionReceiver.EXTRA_DATETIME, it) }
                    putExtra(ActionReceiver.EXTRA_DURATION_MINUTES, suggestedAction.optInt("durationMinutes", 60))
                    suggestedAction.optString("address").ifEmpty { null }?.let { putExtra(ActionReceiver.EXTRA_ADDRESS, it) }
                }
                val actionPi = PendingIntent.getBroadcast(
                    this, notifId + 2, actionIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                builder.addAction(NotificationCompat.Action.Builder(
                    android.R.drawable.ic_menu_agenda, actionLabel, actionPi
                ).build())
            }
        }

        BubbleHelper.attach(this, builder, replyText, formalText, briefText, remoteInputKey, notifId, convKey, intent, openChatIntent, message, detectedIntents, preferredTone, suggestedAction?.toString(), contactMatchJson = contactMatchJson(convKey), suggestionTs = System.currentTimeMillis())

        if (!isDeviceLocked()) nm.notify(notifId, builder.build())

        pendingBubbles[convKey] = PendingBubble(
            replyText, formalText, briefText, replyPendingIntent, remoteInputKey,
            notifId, convKey, intent, openChatIntent, message, detectedIntents,
            suggestedAction?.toString(), markAsReadPendingIntent,
        )

        // Push suggestion to the ConTxt Keyboard. Always send (including reposts) so the
        // keyboard stays in sync when the bubble refreshes after screen unlock / call end.
        sendBroadcast(Intent("com.contxt.keyboard.ACTION_SUGGESTION").apply {
            putExtra("suggestion_casual", replyText)
            if (!formalText.isNullOrEmpty()) putExtra("suggestion_formal", formalText)
            if (!briefText.isNullOrEmpty())  putExtra("suggestion_brief", briefText)
            putExtra("conv_key", convKey)
        })
    }

    fun clearPendingCalendarAction(id: String) {
        try {
            val prefs = Prefs.main(this)
            val arr = JSONArray(prefs.getString("pending_calendar_actions", "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            prefs.edit().putString("pending_calendar_actions", next.toString()).apply()
        } catch (_: Exception) {}
    }

    // Upserts a calendar action into the pending_calendar_actions SharedPrefs list.
    // Keyed by convKey so re-processing the same conversation updates rather than duplicates.
    private fun upsertPendingCalendarAction(action: JSONObject, convKey: String, contactName: String) {
        val prefs = Prefs.main(this)
        try {
            val existing = JSONArray(prefs.getString("pending_calendar_actions", "[]") ?: "[]")
            val next = JSONArray()
            val id = convKey.hashCode().and(0x7FFFFFFF).toString()
            for (i in 0 until existing.length()) {
                val item = existing.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            next.put(JSONObject().apply {
                put("id", id)
                put("title", action.optString("title").ifEmpty { "Event" })
                put("datetime", action.optString("datetime").ifEmpty { null } ?: JSONObject.NULL)
                put("durationMinutes", action.optInt("durationMinutes", 60))
                put("contactName", contactName.ifEmpty { null } ?: JSONObject.NULL)
                put("convKey", convKey)
                put("createdAt", System.currentTimeMillis())
            })
            prefs.edit().putString("pending_calendar_actions", next.toString()).apply()
        } catch (_: Exception) {}
    }

    private fun cacheSuggestion(packageName: String, convKey: String, casual: String, formal: String?, brief: String?, actionJson: String? = null) {
        Prefs.main(this).edit()
            .putString("last_suggestion_$packageName", casual)
            .putString("last_suggestion_formal_$packageName", formal ?: "")
            .putString("last_suggestion_brief_$packageName", brief ?: "")
            .putLong("last_suggestion_ts_$packageName", System.currentTimeMillis())
            .putString("last_suggestion_conv_$packageName", convKey)
            .putString("last_suggestion_action_$packageName", actionJson ?: "")
            .apply()
    }

    private fun enqueuePendingContact(convKey: String, senderName: String, packageName: String) {
        val key = convKey.substringAfter(":")
        if (key.startsWith("group:") || key.startsWith("id:") || groupConvKeys.contains(convKey)) return
        if (senderName.isBlank()) return
        val platform = packageToPlatform(packageName) ?: return
        val prefs = Prefs.main(this)
        val arr = try { JSONArray(prefs.getString("pending_contacts", "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
        for (i in 0 until arr.length()) { if (arr.optJSONObject(i)?.optString("convKey") == convKey) return }
        arr.put(JSONObject().apply {
            put("convKey", convKey)
            put("senderName", senderName)
            put("platform", platform)
        })
        prefs.edit().putString("pending_contacts", arr.toString()).apply()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Only create if the channel doesn't exist — deleting and recreating resets
            // the user's bubble permission on OEM devices (OPPO, Samsung, etc.), which
            // is why we preserve the existing channel when present.
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID, "Reply Suggestions", NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Suggested replies for incoming messages"
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        setAllowBubbles(true)
                    }
                }
                nm.createNotificationChannel(channel)
            }
            // initBubble fires once per app version so the Bubbles toggle appears in settings
            // immediately after install OR after an update (version code changes → re-registers).
            val prefs = Prefs.main(this)
            if (prefs.getInt("bubble_init_version", -1) != BuildConfig.VERSION_CODE) {
                prefs.edit().putInt("bubble_init_version", BuildConfig.VERSION_CODE).apply()
                BubbleHelper.initBubble(this)
            }
            // Silent channel for reposts (unlock, leaving app etc.) — IMPORTANCE_LOW
            // guarantees no sound/vibration at the audio-policy level, which is the only
            // reliable approach on OEM skins that ignore setOnlyAlertOnce on updates.
            if (nm.getNotificationChannel(CHANNEL_SILENT_ID) == null) {
                val silent = NotificationChannel(
                    CHANNEL_SILENT_ID, "Reply Suggestions (silent)", NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Silent updates for existing reply suggestions"
                    setSound(null, null)
                    enableVibration(false)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        setAllowBubbles(true)
                    }
                }
                nm.createNotificationChannel(silent)
            }
        }
    }
}
