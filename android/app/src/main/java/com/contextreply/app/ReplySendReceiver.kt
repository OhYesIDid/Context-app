package com.contextreply.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.RemoteInput
import java.util.concurrent.ConcurrentHashMap

class ReplySendReceiver : BroadcastReceiver() {

    companion object {
        val pendingReplyIntents = ConcurrentHashMap<Int, PendingIntent>()
    }

    override fun onReceive(context: Context, intent: Intent) {
        val notifId = intent.getIntExtra(ContextReplyBgService.EXTRA_NOTIF_ID, -1)
        val convKey = intent.getStringExtra(ContextReplyBgService.EXTRA_CONV_KEY)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notifId != -1) nm.cancel(notifId)

        // On both Send and Dismiss: clear the stored thread so the next message
        // from this contact starts a fresh context window.
        if (convKey != null) {
            NotificationStore.getInstance(context).markReplied(convKey)
        }

        if (intent.action != ContextReplyBgService.ACTION_SEND) return

        val originalSuggestion = intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_TEXT)
        val intentType = intent.getStringExtra(ContextReplyBgService.EXTRA_INTENT)

        val remoteResults = RemoteInput.getResultsFromIntent(intent)
        val replyText = remoteResults
            ?.getCharSequence(ContextReplyBgService.REMOTE_INPUT_KEY)
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?: originalSuggestion
            ?: return

        // Record (original suggestion → what was actually sent) for writing style learning.
        // Sprint 3 will bridge this SharedPreferences queue into the SQLite style_edits table.
        if (originalSuggestion != null && convKey != null) {
            StyleEditQueue.enqueue(context, originalSuggestion, replyText, convKey, intentType)
        }

        val remoteInputKey = intent.getStringExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY)
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
