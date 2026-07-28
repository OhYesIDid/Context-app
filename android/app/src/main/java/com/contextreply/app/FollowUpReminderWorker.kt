package com.contextreply.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

// Nudges the user to open the app and confirm/dismiss an AI-proposed follow-up that's been
// sitting unconfirmed — previously it only ever surfaced via HomeScreen's "suggested" card,
// which requires the user to happen to open the app and look at it. Deliberately mirrors
// ReminderWorker's shape (schedule/cancel/cancelAll via WorkManager, NotificationCompat +
// BroadcastReceiver actions) since that pattern is already proven for the sibling "haven't
// replied to this message" nudge.
class FollowUpReminderWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val id = inputData.getString(KEY_ID) ?: return Result.failure()

        if (!Prefs.main(ctx).getBoolean("reminders_enabled", true)) return Result.success()

        // Re-check the task is still pending — FollowUpStore.dismiss/confirm both cancel this
        // job, but a job WorkManager has already handed to its executor can still run once in
        // flight, so this is the belt-and-suspenders check (same role as ReminderWorker's
        // store.isEmpty(convKey)/hasReminderFired guards).
        val pending = FollowUpStore.getPending(ctx, id) ?: return Result.success()
        val task = pending.optString("task").ifEmpty { null } ?: return Result.success()
        val contactName = pending.optString("contactName").ifEmpty { null }
        val dueHint = pending.optString("dueHint").ifEmpty { null }
        val dueAt = pending.optString("dueAt").ifEmpty { null }

        postFollowUpNotification(ctx, id, task, contactName, dueHint, dueAt)
        return Result.success()
    }

    private fun postFollowUpNotification(
        ctx: Context,
        id: String,
        task: String,
        contactName: String?,
        dueHint: String?,
        dueAt: String?,
    ) {
        val notifId = "followup_$id".hashCode().and(0x7FFFFFFF)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(ProTxtBgService.CHANNEL_FOLLOWUP_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        ProTxtBgService.CHANNEL_FOLLOWUP_ID,
                        "Follow-up suggestions",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Nudges to confirm or dismiss a suggested follow-up"
                    }
                )
            }
        }

        val confirmPi = PendingIntent.getBroadcast(
            ctx, notifId,
            Intent(ctx, FollowUpActionReceiver::class.java).apply {
                action = FollowUpActionReceiver.ACTION_CONFIRM
                putExtra(FollowUpActionReceiver.EXTRA_ID, id)
                putExtra(FollowUpActionReceiver.EXTRA_TASK, task)
                putExtra(FollowUpActionReceiver.EXTRA_CONTACT, contactName)
                putExtra(FollowUpActionReceiver.EXTRA_DUE_HINT, dueHint)
                putExtra(FollowUpActionReceiver.EXTRA_DUE_AT, dueAt)
                putExtra(FollowUpActionReceiver.EXTRA_NOTIF_ID, notifId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val dismissPi = PendingIntent.getBroadcast(
            ctx, notifId + 1,
            Intent(ctx, FollowUpActionReceiver::class.java).apply {
                action = FollowUpActionReceiver.ACTION_DISMISS
                putExtra(FollowUpActionReceiver.EXTRA_ID, id)
                putExtra(FollowUpActionReceiver.EXTRA_NOTIF_ID, notifId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openPi = PendingIntent.getActivity(
            ctx, notifId + 2,
            Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val title = if (contactName != null) "Follow up with $contactName?" else "Follow up?"
        val bigText = if (dueHint != null) "$task\n\nDue: $dueHint" else task

        val notif = NotificationCompat.Builder(ctx, ProTxtBgService.CHANNEL_FOLLOWUP_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(task)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .addAction(0, "Confirm", confirmPi)
            .addAction(0, "Dismiss", dismissPi)
            .setContentIntent(openPi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()

        try {
            @Suppress("MissingPermission")
            NotificationManagerCompat.from(ctx).notify(notifId, notif)
        } catch (_: Exception) {}
    }

    companion object {
        const val KEY_ID = "follow_up_id"

        // Flat delay rather than urgency-scored (ReminderWorker's tiered delays are keyed off
        // detected message urgency — there's no equivalent signal for a follow-up proposal).
        // Long enough that a user who already had the app open and saw the HomeScreen
        // "suggested" card won't also get a redundant notification (their confirm/dismiss
        // cancels the job first); short enough to still be a timely nudge for a suggestion
        // proposed while the app was shut.
        private const val DELAY_MINUTES = 20L

        const val ALL_TAG = "followup_reminder_all"

        fun schedule(context: Context, id: String) {
            val tag = "followup_$id".take(100)
            val request = OneTimeWorkRequestBuilder<FollowUpReminderWorker>()
                .setInitialDelay(DELAY_MINUTES, TimeUnit.MINUTES)
                .addTag(tag)
                .addTag(ALL_TAG)
                .setInputData(Data.Builder().putString(KEY_ID, id).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(tag, ExistingWorkPolicy.REPLACE, request)
        }

        fun cancel(context: Context, id: String) {
            WorkManager.getInstance(context).cancelAllWorkByTag("followup_$id".take(100))
        }

        /** Cancels every pending follow-up reminder job and dismisses any already showing. */
        fun cancelAll(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(ALL_TAG)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                nm.activeNotifications
                    .filter { it.notification.channelId == ProTxtBgService.CHANNEL_FOLLOWUP_ID }
                    .forEach { nm.cancel(it.id) }
            }
        }
    }
}
