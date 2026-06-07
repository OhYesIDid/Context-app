package com.contextreply.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.RemoteInput

class ReplySendReceiver : BroadcastReceiver() {

    companion object {
        // Held in memory for the lifetime of the process — safe because the service
        // and receiver live in the same process and the intent is short-lived.
        var pendingReplyIntent: PendingIntent? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(ContextReplyBgService.NOTIF_ID)

        if (intent.action != ContextReplyBgService.ACTION_SEND) return

        // Prefer RemoteInput text (user edited in notification shade) over original suggestion
        val remoteResults = RemoteInput.getResultsFromIntent(intent)
        val replyText = remoteResults
            ?.getCharSequence(ContextReplyBgService.REMOTE_INPUT_KEY)
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?: intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_TEXT)
            ?: return

        val remoteInputKey = intent.getStringExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: return
        val replyPendingIntent = pendingReplyIntent ?: return

        // Build a reply intent with the text embedded in a RemoteInput bundle
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
            // Original notification was already dismissed — nothing to do
        } finally {
            pendingReplyIntent = null
        }
    }
}
