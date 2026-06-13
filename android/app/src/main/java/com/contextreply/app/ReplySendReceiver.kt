package com.contextreply.app

import android.app.ActivityOptions
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.RemoteInput
import java.util.concurrent.ConcurrentHashMap

class ReplySendReceiver : BroadcastReceiver() {

    companion object {
        val pendingReplyIntents = ConcurrentHashMap<Int, PendingIntent>()
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Open-chat action: fire the WhatsApp contentIntent with its own credentials
        // (zero-arg send uses the PendingIntent creator's UID, same as notification shade)
        if (intent.action == ProTxtBgService.ACTION_OPEN_CHAT) {
            @Suppress("DEPRECATION")
            val pi = intent.getParcelableExtra<PendingIntent>(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT)
            val pkg = intent.getStringExtra(ProTxtBgService.EXTRA_CONV_KEY)?.substringBefore(":") ?: ""
            if (pi != null) {
                try {
                    // API 34+: explicitly allow background activity start so Android
                    // doesn't silently block WhatsApp from coming to the foreground.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        val opts = ActivityOptions.makeBasic().apply {
                            setPendingIntentBackgroundActivityStartMode(
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                            )
                        }
                        pi.send(context, 0, null, null, null, null, opts.toBundle())
                    } else {
                        pi.send()
                    }
                } catch (_: Exception) {
                    // Fallback: open the app home screen
                    if (pkg.isNotEmpty()) {
                        context.packageManager.getLaunchIntentForPackage(pkg)?.apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
                            try { context.startActivity(this) } catch (_: Exception) {}
                        }
                    }
                }
            }
            return
        }

        val notifId = intent.getIntExtra(ProTxtBgService.EXTRA_NOTIF_ID, -1)
        val convKey = intent.getStringExtra(ProTxtBgService.EXTRA_CONV_KEY)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notifId != -1) nm.cancel(notifId)

        // On both Send and Dismiss: clear the stored thread and active bubble tracking
        // so the next message from this contact starts fresh.
        if (convKey != null) {
            NotificationStore.getInstance(context).markReplied(convKey)
            ProTxtBgService.getInstance()?.activeBubbles?.remove(convKey)
            // Stamp send time so onNotificationPosted can suppress the immediate
            // notification update the messaging app posts after receiving our reply.
            ProTxtBgService.getInstance()?.recentlySentAt?.put(convKey, System.currentTimeMillis())
        }

        if (intent.action == ProTxtBgService.ACTION_DISMISS) {
            if (convKey != null) ContactMemory.clearLastSent(context, convKey)
            val original = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
            if (original != null && convKey != null) {
                StyleEditQueue.enqueue(context, original, "", convKey, "dismissed")
            }
            return
        }
        if (intent.action != ProTxtBgService.ACTION_SEND) return

        val originalSuggestion = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
        val intentType = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)

        val remoteResults = RemoteInput.getResultsFromIntent(intent)
        val replyText = remoteResults
            ?.getCharSequence(ProTxtBgService.REMOTE_INPUT_KEY)
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?: originalSuggestion
            ?: return

        // Record (original suggestion → what was actually sent) for writing style learning.
        // Sprint 3 will bridge this SharedPreferences queue into the SQLite style_edits table.
        if (originalSuggestion != null && convKey != null) {
            StyleEditQueue.enqueue(context, originalSuggestion, replyText, convKey, intentType)
        }

        // Persist the outgoing reply so the next worker call for this contact knows
        // what was last said (included in the prompt as "Your last reply to them was: …")
        if (convKey != null) {
            ContactMemory.saveLastSent(context, convKey, replyText)
        }

        val remoteInputKey = intent.getStringExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: return
        val replyPendingIntent = (if (notifId != -1) pendingReplyIntents.remove(notifId) else null)
            ?: return

        val replyIntent = Intent()
        val remoteInput = RemoteInput.Builder(remoteInputKey).build()
        RemoteInput.addResultsToIntent(
            arrayOf(remoteInput),
            replyIntent,
            Bundle().apply { putString(remoteInputKey, replyText) }
        )

        try {
            replyPendingIntent.send(context, 0, replyIntent)
        } catch (_: PendingIntent.CanceledException) {
            // Original notification already dismissed — nothing to do
        }
    }
}
