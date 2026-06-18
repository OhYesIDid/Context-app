package com.contextreply.app

import android.app.ActivityOptions
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.app.RemoteInput
import java.util.concurrent.ConcurrentHashMap

class ReplySendReceiver : BroadcastReceiver() {

    companion object {
        val pendingReplyIntents = ConcurrentHashMap<Int, PendingIntent>()
        val pendingMarkReadIntents = ConcurrentHashMap<Int, PendingIntent>()
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

        // Retry re-runs the worker call in place — it must bypass the shared Send/Dismiss
        // block below, which clears arrivalBuffer/pendingBubbles/activeBubbles. Retry needs
        // all three still intact (pendingBubbles holds the cached args, arrivalBuffer holds
        // the message text) to re-submit the same job.
        if (intent.action == ProTxtBgService.ACTION_RETRY) {
            if (convKey != null) ProTxtBgService.getInstance()?.retry(convKey)
            return
        }

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val skipCancel = intent.getBooleanExtra(ProTxtBgService.EXTRA_SKIP_CANCEL, false)
        if (notifId != -1 && !skipCancel) nm.cancel(notifId)

        // On both Send and Dismiss: clear the stored thread and active bubble tracking
        // so the next message from this contact starts fresh.
        if (convKey != null) {
            NotificationStore.getInstance(context).markReplied(convKey)
            ProTxtBgService.getInstance()?.activeBubbles?.remove(convKey)
            ProTxtBgService.getInstance()?.arrivalBuffer?.remove(convKey)
            ProTxtBgService.pendingBubbles.remove(convKey)
            // Stamp send time keyed by "$packageName:sbnId" — the messaging app's sbn.id
            // stays constant for a conversation even when the title changes to "You" on
            // the outbound update, which would otherwise produce a different convKey.
            val pkg = convKey.substringBefore(":")
            val sbnId = ProTxtBgService.getInstance()?.sbnIdByConvKey?.get(convKey)
            if (sbnId != null) {
                ProTxtBgService.getInstance()?.recentlySentAt?.put("$pkg:$sbnId", System.currentTimeMillis())
            }
        }

        // After this slot is freed, promote any overflow bubbles that Android suppressed
        // because the 6-active-bubble limit was hit (short delay lets the cancel settle first).
        Handler(Looper.getMainLooper()).postDelayed({
            ProTxtBgService.getInstance()?.repostPendingBubbles()
        }, 500L)

        if (intent.action == ProTxtBgService.ACTION_MARK_READ) {
            if (convKey != null) ContactMemory.clearLastSent(context, convKey)
            val markReadPi = if (notifId != -1) pendingMarkReadIntents.remove(notifId) else null
            if (markReadPi != null) {
                try { markReadPi.send() } catch (_: PendingIntent.CanceledException) {}
            }
            return
        }

        if (intent.action == ProTxtBgService.ACTION_DISMISS) {
            if (convKey != null) ContactMemory.clearLastSent(context, convKey)
            val noReply = intent.getBooleanExtra(ProTxtBgService.EXTRA_NO_REPLY, false)
            if (!noReply) {
                val original = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
                if (original != null && convKey != null) {
                    StyleEditQueue.enqueue(context, original, "", convKey, "dismissed")
                }
            }
            return
        }

        if (intent.action == ProTxtBgService.ACTION_COPY) {
            val replyText = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT) ?: return
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("suggested reply", replyText))
            val intentType = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)
            if (convKey != null) {
                StyleEditQueue.enqueue(context, replyText, replyText, convKey, intentType)
                ContactMemory.saveLastSent(context, convKey, replyText)
            }
            return
        }

        if (intent.action != ProTxtBgService.ACTION_SEND) return

        // EXTRA_ORIGINAL_SUGGESTION carries the AI's suggestion before any user edit (set by
        // BubbleSuggestionActivity). Fall back to EXTRA_REPLY_TEXT for notification-shade sends
        // where the action Intent already holds the unedited suggestion in that field.
        val originalSuggestion = intent.getStringExtra(ProTxtBgService.EXTRA_ORIGINAL_SUGGESTION)
            ?: intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
        val intentType = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)
        val toneSelected = intent.getStringExtra(ProTxtBgService.EXTRA_TONE_SELECTED)

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
            StyleEditQueue.enqueue(context, originalSuggestion, replyText, convKey, intentType, toneSelected)
            // Immediately update the native "recent edits" cache so the next background
            // suggestion reflects this edit without waiting for the app to open.
            NativeStyleSync.syncFromQueue(context)
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

        // Mark the conversation as read in the original app now that we've sent a reply.
        val markReadPi = if (notifId != -1) pendingMarkReadIntents.remove(notifId) else null
        if (markReadPi != null) {
            try { markReadPi.send() } catch (_: PendingIntent.CanceledException) {}
        }
    }
}
