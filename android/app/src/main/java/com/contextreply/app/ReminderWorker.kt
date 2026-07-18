package com.contextreply.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Data
import java.util.concurrent.TimeUnit

class ReminderWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val convKey = inputData.getString(KEY_CONV_KEY) ?: return Result.failure()

        // Abort if reminders were disabled after scheduling
        if (!Prefs.main(ctx).getBoolean("reminders_enabled", true)) return Result.success()

        val store = NotificationStore.getInstance(ctx)

        // Abort if the conversation was already replied to or reminder already fired
        if (store.isEmpty(convKey)) return Result.success()
        if (store.hasReminderFired(convKey)) return Result.success()

        val thread = store.getThread(convKey)
        if (thread.isEmpty()) return Result.success()
        val latestMessage = thread.lastOrNull()?.second ?: return Result.success()

        val senderName = ProTxtBgService.stripAppPrefix(convKey.substringAfter(":"))

        val result = WorkerClient.call(
            ctx,
            latestMessage,
            thread,
            earlierContext = store.getEarlierContext(convKey),
            contactMemory  = ContactMemory.buildMemoryBlock(ctx, convKey),
            lastSentReply  = ContactMemory.getLastSent(ctx, convKey),
            contactContext = ContactSignals.getContactContext(ctx, convKey),
            contactName    = senderName,
            strategy       = "reminder",
        ) ?: return Result.retry()

        if (result.rateLimited) return Result.retry()

        val suggestion = result.replies.optString("casual").takeIf { it.isNotEmpty() }
            ?: result.replies.optString("brief").takeIf { it.isNotEmpty() }
            ?: result.replies.optString("formal").takeIf { it.isNotEmpty() }
            ?: return Result.failure()

        store.markReminderFired(convKey)
        postReminderNotification(ctx, convKey, senderName, latestMessage, suggestion)
        return Result.success()
    }

    private fun postReminderNotification(
        ctx: Context,
        convKey: String,
        senderName: String,
        originalMessage: String,
        suggestion: String,
    ) {
        val notifId = "reminder_$convKey".hashCode().and(0x7FFFFFFF)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(ProTxtBgService.CHANNEL_REMINDER_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        ProTxtBgService.CHANNEL_REMINDER_ID,
                        "Reply Reminders",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Reminders to reply to messages you haven't responded to"
                    }
                )
            }
        }

        val copyPi = PendingIntent.getBroadcast(
            ctx, notifId,
            Intent(ctx, ReminderActionReceiver::class.java).apply {
                action = ReminderActionReceiver.ACTION_COPY
                putExtra(ReminderActionReceiver.EXTRA_CONV_KEY, convKey)
                putExtra(ReminderActionReceiver.EXTRA_SUGGESTION, suggestion)
                putExtra(ReminderActionReceiver.EXTRA_NOTIF_ID, notifId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val dismissPi = PendingIntent.getBroadcast(
            ctx, notifId + 1,
            Intent(ctx, ReminderActionReceiver::class.java).apply {
                action = ReminderActionReceiver.ACTION_DISMISS
                putExtra(ReminderActionReceiver.EXTRA_CONV_KEY, convKey)
                putExtra(ReminderActionReceiver.EXTRA_NOTIF_ID, notifId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val quote = originalMessage.take(100).let { if (it.length < originalMessage.length) "$it…" else it }
        val bigText = "\"$quote\"\n\nSuggested reply: \"${suggestion.take(160)}\""

        val notif = NotificationCompat.Builder(ctx, ProTxtBgService.CHANNEL_REMINDER_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Haven't replied to $senderName")
            .setContentText(suggestion.take(80))
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .addAction(0, "Copy reply", copyPi)
            .addAction(0, "Dismiss", dismissPi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()

        try {
            @Suppress("MissingPermission")
            NotificationManagerCompat.from(ctx).notify(notifId, notif)
        } catch (_: Exception) {}
    }

    companion object {
        const val KEY_CONV_KEY = "conv_key"

        private val URGENCY_DELAYS_MINUTES = longArrayOf(
            6 * 60L,  // 0 = low:      6 hours
            2 * 60L,  // 1 = normal:   2 hours
            45L,      // 2 = high:     45 minutes
            15L,      // 3 = critical: 15 minutes
        )

        const val ALL_TAG = "reminder_all"

        fun schedule(context: Context, convKey: String, urgencyScore: Int) {
            val delay = URGENCY_DELAYS_MINUTES[urgencyScore.coerceIn(0, 3)]
            val tag = "reminder_$convKey".take(100)
            val request = OneTimeWorkRequestBuilder<ReminderWorker>()
                .setInitialDelay(delay, TimeUnit.MINUTES)
                .addTag(tag)
                .addTag(ALL_TAG)
                .setInputData(Data.Builder().putString(KEY_CONV_KEY, convKey).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                tag,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }

        fun cancel(context: Context, convKey: String) {
            WorkManager.getInstance(context).cancelAllWorkByTag("reminder_$convKey".take(100))
        }

        /** Cancels every pending reminder job and dismisses any reminder notifications already showing. */
        fun cancelAll(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(ALL_TAG)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                nm.activeNotifications
                    .filter { it.notification.channelId == ProTxtBgService.CHANNEL_REMINDER_ID }
                    .forEach { nm.cancel(it.id) }
            }
        }
    }
}
