package com.contextreply.app

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
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

class ContextReplyBgService : NotificationListenerService() {

    companion object {
        @Volatile private var instance: ContextReplyBgService? = null
        fun getInstance(): ContextReplyBgService? = instance

        const val CHANNEL_ID = "contextreply_suggestions"
        const val ACTION_SEND = "com.protxt.app.ACTION_SEND_REPLY"
        const val ACTION_DISMISS = "com.protxt.app.ACTION_DISMISS_REPLY"
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
        const val ACTION_OPEN_CHAT = "com.protxt.app.ACTION_OPEN_CHAT"
        const val REMOTE_INPUT_KEY = "contextreply_edited_reply"
        // Sentinel placed in EXTRA_REPLY_TEXT while the worker is in-flight.
        // BubbleSuggestionActivity detects this and shows a loading state.
        const val LOADING_PLACEHOLDER = "__loading__"

        // Collapses rapid-fire messages from the same thread into one API call
        private const val DEBOUNCE_MS = 2_500L

        val TARGET_PACKAGES = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.telegram.messenger",
            "com.facebook.orca",
            "org.thoughtcrime.securesms",
            "com.google.android.apps.messaging",
            "com.instagram.android",
        )

        private val NO_REPLY_TEXT_PATTERNS = listOf(
            Regex("^(WhatsApp |Telegram )?(audio |video )?call$", RegexOption.IGNORE_CASE),
            Regex("^missed (voice |video )?call", RegexOption.IGNORE_CASE),
            Regex("\\bmissed call\\b", RegexOption.IGNORE_CASE),
            Regex("^(voice|video) message$", RegexOption.IGNORE_CASE),
            Regex("reacted to your (message|story|photo|reel|post)", RegexOption.IGNORE_CASE),
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
    }

    private val pendingJobs   = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val arrivalBuffer = ConcurrentHashMap<String, MutableList<String>>()
    // Tracks convKeys that currently have a live bubble so we don't stack duplicates.
    // Cleared by ReplySendReceiver on send or dismiss.
    val activeBubbles = ConcurrentHashMap.newKeySet<String>()
    private val lastOpenedTimestamp = ConcurrentHashMap<String, Long>()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val workerPool = Executors.newFixedThreadPool(3)
    private lateinit var store: NotificationStore

    @Volatile private var lastLocation: Location? = null
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) { lastLocation = loc }
        @Deprecated("Deprecated in Java") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        store = NotificationStore.getInstance(this)
        createChannel()
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE).edit()
            .putBoolean("nls_connected", true).apply()
        // Keep location warm so ETA requests are instant
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).forEach { provider ->
            try {
                if (lm.isProviderEnabled(provider))
                    lm.requestLocationUpdates(provider, 60_000L, 100f, locationListener, mainLooper)
            } catch (_: SecurityException) {}
        }
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE).edit()
            .putBoolean("nls_connected", false).apply()
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

        if (BuildConfig.DEBUG) android.util.Log.d("ContextReply", "notif from ${sbn.packageName} cat=${notification.category} actions=${notification.actions?.size ?: 0}")

        // Gate 0: skip group-summary notifications — WhatsApp/Telegram post one real
        // per-conversation notification (tagged with JID hash) and one summary notification
        // (FLAG_GROUP_SUMMARY, untagged). Both can pass subsequent gates but with different
        // titles → different convKeys → duplicate bubbles. Only process the real one.
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        // Gate 1: messaging category only
        if (notification.category != null && notification.category != Notification.CATEGORY_MESSAGE) {
            if (BuildConfig.DEBUG) android.util.Log.d("ContextReply", "filtered: wrong category ${notification.category}")
            return
        }

        // Gate 2: must have an inline-reply action
        val replyAction = notification.actions?.firstOrNull { action ->
            action?.remoteInputs?.isNotEmpty() == true
        } ?: run {
            if (BuildConfig.DEBUG) android.util.Log.d("ContextReply", "filtered: no reply action")
            return
        }

        val remoteInputKey = replyAction.remoteInputs?.firstOrNull()?.resultKey ?: return
        val replyPendingIntent = replyAction.actionIntent ?: return
        val openChatIntent = notification.contentIntent

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: return

        if (text.length < 8) return

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

        // Track each notification's text so the debounce callback sees the full burst
        arrivalBuffer.getOrPut(convKey) { mutableListOf() }.add(text)

        // ── Accumulate messages in local store ───────────────────────────────
        // Extract the structured thread from this notification's bundle.
        val notifThread = extractConversationThread(extras)

        if (store.isEmpty(convKey)) {
            // First message from this conversation — seed store with full EXTRA_MESSAGES
            // context. WhatsApp/Telegram bundle recent history here, giving Claude
            // background on the thread from the very first notification.
            notifThread.forEach { (sender, msgText) ->
                store.appendMessage(convKey, sender, msgText)
            }
        } else {
            // Conversation already cached — append only the new trigger message
            // to avoid duplicating the history already in the store.
            notifThread.lastOrNull()?.let { (sender, msgText) ->
                store.appendMessage(convKey, sender, msgText)
            }
        }

        // Debounce: cancel any existing scheduled call for this conversation and
        // reschedule. A burst of messages waits for the last one to settle.
        val packageName = sbn.packageName
        pendingJobs[convKey]?.cancel(false)
        pendingJobs[convKey] = scheduler.schedule({
            pendingJobs.remove(convKey)
            val fullThread = store.getThread(convKey)
            // Drain the arrival buffer — all texts that came in during the debounce window.
            // This is more reliable than a sender-based walk-back because it doesn't depend
            // on apps correctly setting sender=null for outgoing MessagingStyle messages.
            val burstTexts = arrivalBuffer.remove(convKey)
                ?.distinct()
                ?.takeIf { it.isNotEmpty() }
                ?: listOf(fullThread.lastOrNull()?.second ?: text)
            val latestMessage = burstTexts.joinToString("\n")
            if (BuildConfig.DEBUG) android.util.Log.d("ContextReply", "burst ${burstTexts.size} msgs: ${latestMessage.take(120)}")

            if (activeBubbles.contains(convKey)) return@schedule
            val detectedIntentsStr = detectIntents(latestMessage).joinToString(",")
            activeBubbles.add(convKey)
            // Only show loading bubble when the user is not already in the messaging app.
            // When they are in the app, the IME overlay handles the suggestion instead.
            val userInApp = ContextReplyAccessibilityService.activePackage == packageName
            if (!userInApp) {
                postLoadingNotification(notifId, convKey, replyPendingIntent, remoteInputKey, openChatIntent, latestMessage, detectedIntentsStr)
            }
            val contactMemory = ContactMemory.getMemory(this, convKey)
            val lastSent = ContactMemory.getLastSent(this, convKey)
            workerPool.submit {
                try {
                    val enrichments = buildEnrichments(latestMessage)
                    val result = WorkerClient.call(
                        this, latestMessage, fullThread, enrichments,
                        contactMemory = contactMemory,
                        lastSentReply = lastSent,
                    ) ?: run {
                        activeBubbles.remove(convKey)
                        return@submit
                    }
                    // Persist context update for future conversations with this contact
                    result.contextUpdate?.let { ContactMemory.saveMemory(this, convKey, it) }
                    // User may have dismissed the loading bubble — don't post a stale result
                    if (!activeBubbles.contains(convKey)) return@submit
                    val casual = result.replies.optString("casual").takeIf { it.isNotEmpty() }
                    val formal = result.replies.optString("formal").takeIf { it.isNotEmpty() }
                    val brief  = result.replies.optString("brief").takeIf { it.isNotEmpty() }
                    val primary = casual ?: formal ?: brief ?: run {
                        activeBubbles.remove(convKey)
                        return@submit
                    }
                    // Route to bubble unless the user is currently in the messaging app,
                    // in which case the IME overlay picks it up via the onSuggestionReady callback.
                    val nowInApp = ContextReplyAccessibilityService.activePackage == packageName
                    if (!nowInApp) {
                        postSuggestionNotification(
                            primary, formal, brief,
                            replyPendingIntent, remoteInputKey, notifId, convKey, result.intent,
                            openChatIntent, latestMessage, detectedIntentsStr
                        )
                    } else {
                        // Save to SharedPrefs so the overlay can read the suggestion
                        cacheSuggestion(packageName, convKey, primary, formal, brief)
                    }
                    // Notify the IME overlay — shows/refreshes strip if the app is in focus
                    android.util.Log.e("ContextReply", "worker done nowInApp=$nowInApp pkg=$packageName onSuggestionReady=${ContextReplyAccessibilityService.onSuggestionReady != null}")
                    ContextReplyAccessibilityService.onSuggestionReady?.invoke(packageName)
                    // Update the Activity if it's already open showing the loading state
                    BubbleSuggestionActivity.onReplyReady?.invoke(primary, formal, brief)
                    BubbleSuggestionActivity.onReplyReady = null
                } catch (_: Exception) {
                    activeBubbles.remove(convKey)
                }
            }
        }, DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap, reason: Int) {
        if (sbn.packageName !in TARGET_PACKAGES) return
        if (reason != REASON_APP_CANCEL) return

        // User opened the messaging app — note the timestamp and record which
        // conversation was active. Used by the IME (Sprint 2) to know which
        // thread to show a suggestion for when the keyboard opens.
        lastOpenedTimestamp[sbn.packageName] = System.currentTimeMillis()

        val extras = sbn.notification?.extras ?: return
        val conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: return

        // T2-C: When the accessibility service is active the user is likely about to reply
        // inside the app via the IME overlay. Cancel any visible bubble notification, but
        // let the pending worker job continue — it will route the result to the overlay
        // instead of posting a new bubble.
        if (isAccessibilityEnabled()) {
            val convKey = buildConversationKey(sbn, extras)
            val notifId = convKey.hashCode().and(0x7FFFFFFF)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
            // Keep activeBubbles entry so the in-flight worker still posts its result
            // (postSuggestionNotification checks activePackage and skips the bubble).
        }

        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("last_opened_conv_${sbn.packageName}", conversationTitle)
            .apply()
    }

    private fun buildConversationKey(sbn: StatusBarNotification, extras: Bundle): String {
        val packageName = sbn.packageName
        val conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val isGroup = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        // For group chats without an explicit conversation title (e.g. Telegram groups use
        // sender name as EXTRA_TITLE rather than group name), fall back to the notification
        // ID which is stable per-conversation in WhatsApp, Telegram, and Messenger.
        val key = when {
            conversationTitle != null -> conversationTitle
            isGroup -> "group:${sbn.id}"
            else -> title ?: "unknown"
        }
        if (BuildConfig.DEBUG) android.util.Log.d("ContextReply", "convKey=$packageName:$key  isGroup=$isGroup  title=$title  convTitle=$conversationTitle  sbnId=${sbn.id}")
        return "$packageName:$key"
    }

    private fun shouldSkipGroupMessages(): Boolean =
        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .getBoolean("skip_group_messages", false)

    private fun extractConversationThread(extras: Bundle): List<Pair<String?, String>> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return emptyList()
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES) ?: return emptyList()
        return messages.mapNotNull { msg ->
            if (msg !is Bundle) return@mapNotNull null
            val text = msg.getCharSequence("android.text")?.toString() ?: return@mapNotNull null
            val sender = msg.getCharSequence("android.sender")?.toString()
            Pair(sender, text)
        }
    }

    private data class EtaData(val duration: String, val distance: String, val routeSummary: String)

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
        Regex("""\b(meeting|catch.?up|call|chat)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b""", RegexOption.IGNORE_CASE),
        Regex("""\b(this|next) (week|weekend|morning|afternoon|evening)\b""", RegexOption.IGNORE_CASE),
        Regex("""\btomorrow\b""", RegexOption.IGNORE_CASE),
        Regex("""\btonight\b""", RegexOption.IGNORE_CASE),
        Regex("""are you (around|up for|down for)""", RegexOption.IGNORE_CASE),
        // event-lookup: "when is X?", "what day/date/time is X?"
        Regex("""\bwhen (?:is|are)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bwhat (?:day|date|time) (?:is|are)\b""", RegexOption.IGNORE_CASE),
        Regex("""\bwhat (?:is|are) the (?:date|day|time)\b""", RegexOption.IGNORE_CASE),
    )

    private val INTENT_ENRICHMENTS = mapOf(
        "eta"          to listOf("maps"),
        "availability" to listOf("calendar"),
        "other"        to listOf<String>(),
    )

    private fun detectIntents(message: String): List<String> {
        val intents = mutableListOf<String>()
        if (ETA_PATTERNS.any { it.containsMatchIn(message) }) intents.add("eta")
        if (AVAILABILITY_PATTERNS.any { it.containsMatchIn(message) }) intents.add("availability")
        return intents.ifEmpty { listOf("other") }
    }

    private fun requiredEnrichments(message: String): List<String> =
        detectIntents(message).flatMap { INTENT_ENRICHMENTS[it] ?: emptyList() }.distinct()

    private fun buildEnrichments(message: String): JSONObject {
        val enrichments = JSONObject()
        for (key in requiredEnrichments(message)) {
            when (key) {
                "maps" -> fetchEtaData(message)?.let { eta ->
                    enrichments.put("maps", JSONObject().apply {
                        put("duration", eta.duration)
                        put("distance", eta.distance)
                        put("routeSummary", eta.routeSummary)
                    })
                }
                "calendar" -> fetchCalendarData(message)?.let { cal ->
                    enrichments.put("calendar", cal)
                }
            }
        }
        return enrichments
    }

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
        conn.setRequestProperty("Authorization", "Bearer $token")
        return try {
            JSONObject(conn.inputStream.bufferedReader().readText()).optJSONArray("items") ?: JSONArray()
        } finally {
            conn.disconnect()
        }
    }

    private fun fetchCalendarData(message: String): JSONObject? {
        val keyword = extractEventKeyword(message)
        return try {
            val account = GoogleSignIn.getLastSignedInAccount(this) ?: return null
            val token = GoogleAuthUtil.getToken(
                this,
                account.account ?: return null,
                "oauth2:https://www.googleapis.com/auth/calendar.readonly"
            )
            val now = Instant.now()
            val windowStart = if (keyword != null) now.minus(14, ChronoUnit.DAYS) else now
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
                put("windowStart", OffsetDateTime.ofInstant(now, ZoneOffset.UTC).toString())
                put("windowEnd", OffsetDateTime.ofInstant(windowEnd, ZoneOffset.UTC).toString())
            }
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) android.util.Log.w("ContextReplyBgService", "Calendar fetch failed: ${e.message}")
            null
        }
    }

    private fun isEtaIntent(message: String): Boolean = ETA_PATTERNS.any { it.containsMatchIn(message) }

    private fun getCurrentLocation(): Location? {
        if (lastLocation != null) return lastLocation
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        return try {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.FUSED_PROVIDER)
                .mapNotNull { provider ->
                    try { lm.getLastKnownLocation(provider) } catch (_: SecurityException) { null }
                }
                .maxByOrNull { it.time }
        } catch (_: Exception) { null }
    }

    private fun extractDestination(message: String): String? {
        val patterns = listOf(
            // "how far are you from Tesco", "far from the office"
            Regex("""(?:how far|far) (?:are you |is it )?from (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            // "are you near Tesco", "are you at Waterloo"
            Regex("""(?:near|at|by|outside|around) (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
            // "distance from Tesco"
            Regex("""distance (?:from|to) (.+?)(?:\?|$)""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { re ->
            re.find(message)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.length > 1 }
        }
    }

    private fun getEnrichmentPref(enrichment: String, key: String, default: String): String {
        val prefs = getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
        return try {
            JSONObject(prefs.getString("enrichment_prefs", "{}") ?: "{}")
                .optJSONObject(enrichment)?.optString(key)?.ifEmpty { null } ?: default
        } catch (_: Exception) { default }
    }

    private fun fetchEtaData(message: String): EtaData? {
        val apiKey = BuildConfig.GOOGLE_MAPS_API_KEY.ifEmpty { return null }
        val location = getCurrentLocation() ?: return null
        val destination = extractDestination(message) ?: return null
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
            if (obj.optString("status") != "OK") return null
            val leg = obj.getJSONArray("routes").getJSONObject(0).getJSONArray("legs").getJSONObject(0)
            val duration = (leg.optJSONObject("duration_in_traffic") ?: leg.getJSONObject("duration"))
                .getString("text")
            val distance = leg.getJSONObject("distance").getString("text")
            val route = obj.getJSONArray("routes").getJSONObject(0).optString("summary", "")
            EtaData(duration, distance, route)
        } catch (_: Exception) { null }
    }

    private fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = android.provider.Settings.Secure.getString(
            contentResolver, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.contains("$packageName/com.contextreply.app.ContextReplyAccessibilityService")
    }

    private fun postLoadingNotification(
        notifId: Int,
        convKey: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        openChatIntent: PendingIntent?,
        message: String,
        detectedIntents: String,
    ) {
        ReplySendReceiver.pendingReplyIntents[notifId] = replyPendingIntent
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
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Drafting reply…")
            .setContentText("Thinking…")
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup("contextreply_suggestions")
        BubbleHelper.attach(
            this, builder,
            LOADING_PLACEHOLDER, null, null,
            remoteInputKey, notifId, convKey, null,
            openChatIntent, message, detectedIntents,
            preferredToneForContact(convKey)
        )
        nm.notify(notifId, builder.build())
    }

    private fun preferredToneForContact(convKey: String): String? {
        val contact = convKey.substringAfter(":").lowercase()
        return try {
            val json = getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
                .getString("contact_tone_map", "{}") ?: "{}"
            JSONObject(json).optString(contact).ifEmpty { null }
        } catch (_: Exception) { null }
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
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        val sendPi = PendingIntent.getBroadcast(this, notifId, sendIntent, flags)

        ReplySendReceiver.pendingReplyIntents[notifId] = replyPendingIntent

        val dismissIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_DISMISS
            putExtra(EXTRA_NOTIF_ID, notifId)
            putExtra(EXTRA_CONV_KEY, convKey)
            putExtra(EXTRA_REPLY_TEXT, replyText)
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, notifId + 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Store all suggestion tones for AccessibilityService overlay + bubble
        val packageName = convKey.substringBefore(":")
        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE).edit()
            .putString("last_suggestion_$packageName", replyText)
            .putString("last_suggestion_formal_$packageName", formalText ?: "")
            .putString("last_suggestion_brief_$packageName", briefText ?: "")
            .putLong("last_suggestion_ts_$packageName", System.currentTimeMillis())
            .putString("last_suggestion_conv_$packageName", convKey)
            .apply()

        val sendAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, "Send", sendPi
        ).build()

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Suggested reply")
            .setContentText(replyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(replyText))
            .addAction(sendAction)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setGroup("contextreply_suggestions")

        BubbleHelper.attach(this, builder, replyText, formalText, briefText, remoteInputKey, notifId, convKey, intent, openChatIntent, message, detectedIntents, preferredTone)

        nm.notify(notifId, builder.build()
        )
    }

    private fun cacheSuggestion(packageName: String, convKey: String, casual: String, formal: String?, brief: String?) {
        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE).edit()
            .putString("last_suggestion_$packageName", casual)
            .putString("last_suggestion_formal_$packageName", formal ?: "")
            .putString("last_suggestion_brief_$packageName", brief ?: "")
            .putLong("last_suggestion_ts_$packageName", System.currentTimeMillis())
            .putString("last_suggestion_conv_$packageName", convKey)
            .apply()
    }

    private fun isAppInForeground(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.runningAppProcesses?.any {
            it.processName == packageName &&
            it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } == true
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Only create if the channel doesn't exist — deleting and recreating resets
            // the user's bubble permission on OEM devices (OPPO, Samsung, etc.), which
            // is why we preserve the existing channel when present.
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
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
    }
}
