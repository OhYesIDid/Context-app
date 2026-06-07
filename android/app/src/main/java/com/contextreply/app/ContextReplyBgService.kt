package com.contextreply.app

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.NotificationListenerService.RankingMap
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class ContextReplyBgService : NotificationListenerService() {

    companion object {
        const val CHANNEL_ID = "contextreply_suggestions"
        const val ACTION_SEND = "com.contextreply.app.ACTION_SEND_REPLY"
        const val ACTION_DISMISS = "com.contextreply.app.ACTION_DISMISS_REPLY"
        const val EXTRA_REPLY_TEXT = "reply_text"
        const val EXTRA_REMOTE_INPUT_KEY = "remote_input_key"
        const val EXTRA_NOTIF_ID = "notif_id"
        const val EXTRA_CONV_KEY = "conv_key"
        const val EXTRA_INTENT = "reply_intent"
        const val REMOTE_INPUT_KEY = "contextreply_edited_reply"

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

    private data class WorkerResult(val replies: JSONObject, val intent: String?)

    private val pendingJobs = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val lastOpenedTimestamp = ConcurrentHashMap<String, Long>()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val workerPool = Executors.newFixedThreadPool(3)
    private lateinit var store: NotificationStore

    override fun onCreate() {
        super.onCreate()
        store = NotificationStore.getInstance(this)
        createChannel()
    }

    override fun onDestroy() {
        super.onDestroy()
        scheduler.shutdownNow()
        workerPool.shutdownNow()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in TARGET_PACKAGES) return
        if (isAppInForeground()) return

        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        // Gate 1: messaging category only
        if (notification.category != null && notification.category != Notification.CATEGORY_MESSAGE) return

        // Gate 2: must have an inline-reply action
        val replyAction = notification.actions?.firstOrNull { action ->
            action?.remoteInputs?.isNotEmpty() == true
        } ?: return

        val remoteInputKey = replyAction.remoteInputs?.firstOrNull()?.resultKey ?: return
        val replyPendingIntent = replyAction.actionIntent ?: return

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

        val convKey = buildConversationKey(sbn.packageName, extras)
        val notifId = convKey.hashCode().and(0x7FFFFFFF)

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
            val latestMessage = fullThread.lastOrNull()?.second ?: text

            workerPool.submit {
                try {
                    val result = callWorker(latestMessage, fullThread) ?: return@submit
                    val suggestion = result.replies.optString("casual").takeIf { it.isNotEmpty() }
                        ?: result.replies.optString("brief").takeIf { it.isNotEmpty() }
                        ?: return@submit
                    postSuggestionNotification(
                        suggestion, replyPendingIntent, remoteInputKey, notifId, convKey, result.intent
                    )
                } catch (_: Exception) {}
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

        getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("last_opened_conv_${sbn.packageName}", conversationTitle)
            .apply()
    }

    private fun buildConversationKey(packageName: String, extras: Bundle): String {
        val conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        return "$packageName:${conversationTitle ?: title ?: "unknown"}"
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

    private fun callWorker(message: String, thread: List<Pair<String?, String>>): WorkerResult? {
        val url = URL("${BuildConfig.WORKER_URL}/suggest")
        val conn = url.openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000

            val body = JSONObject().apply {
                put("message", message)
                if (thread.isNotEmpty()) {
                    put("conversationThread", JSONArray().also { arr ->
                        thread.forEach { (sender, text) ->
                            arr.put(JSONObject().apply {
                                if (sender != null) put("sender", sender) else put("sender", JSONObject.NULL)
                                put("text", text)
                            })
                        }
                    })
                }
            }.toString()

            conn.outputStream.bufferedWriter().use { it.write(body) }
            if (conn.responseCode != 200) return null
            val response = conn.inputStream.bufferedReader().use { it.readText() }
            val responseObj = JSONObject(response)
            val replies = responseObj.optJSONObject("replies") ?: return null
            val intent = responseObj.optString("intent").ifEmpty { null }
            WorkerResult(replies, intent)
        } finally {
            conn.disconnect()
        }
    }

    private fun postSuggestionNotification(
        replyText: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
        notifId: Int,
        convKey: String,
        intent: String? = null,
    ) {
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
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, notifId + 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val remoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY)
            .setLabel("Edit reply…")
            .build()

        val sendAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, "Send", sendPi
        ).addRemoteInput(remoteInput).build()

        nm.notify(notifId, NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Suggested reply")
            .setContentText(replyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(replyText))
            .addAction(sendAction)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setGroup("contextreply_suggestions")
            .build()
        )
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
            val channel = NotificationChannel(
                CHANNEL_ID, "Reply Suggestions", NotificationManager.IMPORTANCE_HIGH
            ).apply { description = "Suggested replies for incoming messages" }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }
}
