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
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class ContextReplyBgService : NotificationListenerService() {

    companion object {
        const val CHANNEL_ID = "contextreply_suggestions"
        const val NOTIF_ID = 9001
        const val ACTION_SEND = "com.contextreply.app.ACTION_SEND_REPLY"
        const val ACTION_DISMISS = "com.contextreply.app.ACTION_DISMISS_REPLY"
        const val EXTRA_REPLY_TEXT = "reply_text"
        const val EXTRA_REMOTE_INPUT_KEY = "remote_input_key"
        const val REMOTE_INPUT_KEY = "contextreply_edited_reply"

        val TARGET_PACKAGES = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.telegram.messenger",
            "com.facebook.orca",
            "org.thoughtcrime.securesms",
            "com.google.android.apps.messaging",
            "com.instagram.android",
        )

        private val executor = Executors.newSingleThreadExecutor()
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in TARGET_PACKAGES) return
        if (isAppInForeground()) return

        val extras = sbn.notification?.extras ?: return

        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: return

        if (text.length < 8) return
        if (text.matches(Regex("^\\d+ (new )?messages?$"))) return

        val replyAction = sbn.notification?.actions?.firstOrNull { action ->
            action?.remoteInputs?.isNotEmpty() == true
        } ?: return

        val remoteInputKey = replyAction.remoteInputs?.firstOrNull()?.resultKey ?: return
        val replyPendingIntent = replyAction.actionIntent ?: return

        // Extract full conversation thread from MessagingStyle extras (API 24+)
        val thread = extractConversationThread(extras)

        executor.submit {
            try {
                val replies = callWorker(text, thread) ?: return@submit
                val suggestion = replies.optString("casual").takeIf { it.isNotEmpty() }
                    ?: replies.optString("brief").takeIf { it.isNotEmpty() }
                    ?: return@submit

                postSuggestionNotification(suggestion, replyPendingIntent, remoteInputKey)
            } catch (_: Exception) {
                // Silent failure — don't interrupt the user with error notifications
            }
        }
    }

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

    private fun callWorker(message: String, thread: List<Pair<String?, String>>): JSONObject? {
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
                // No intent sent — Worker auto-detects from message text
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
            JSONObject(response).optJSONObject("replies")
        } finally {
            conn.disconnect()
        }
    }

    private fun postSuggestionNotification(
        replyText: String,
        replyPendingIntent: PendingIntent,
        remoteInputKey: String,
    ) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val sendIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_SEND
            putExtra(EXTRA_REPLY_TEXT, replyText)
            putExtra(EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        val sendPi = PendingIntent.getBroadcast(this, 0, sendIntent, flags)

        ReplySendReceiver.pendingReplyIntent = replyPendingIntent

        val dismissIntent = Intent(this, ReplySendReceiver::class.java).apply {
            action = ACTION_DISMISS
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val remoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY)
            .setLabel("Edit reply…")
            .build()

        val sendAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, "Send", sendPi
        ).addRemoteInput(remoteInput).build()

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Suggested reply")
            .setContentText(replyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(replyText))
            .addAction(sendAction)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()

        nm.notify(NOTIF_ID, notification)
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
                CHANNEL_ID,
                "Reply Suggestions",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Suggested replies for incoming messages"
            }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }
}
