package com.contextreply.app

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Handles taps on the FollowUpReminderWorker notification's Confirm/Dismiss actions. Goes
// through FollowUpStore (not ProTxtBgService.getInstance()) since this can run with the
// background service not alive — the notification may fire well after the app process died.
class FollowUpActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, -1)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notifId != -1) nm.cancel(notifId)

        when (intent.action) {
            ACTION_CONFIRM -> {
                val task = intent.getStringExtra(EXTRA_TASK) ?: return
                val contactName = intent.getStringExtra(EXTRA_CONTACT) ?: ""
                val dueHint = intent.getStringExtra(EXTRA_DUE_HINT)
                val dueAt = intent.getStringExtra(EXTRA_DUE_AT)
                FollowUpStore.confirm(context, id, task, contactName, dueHint, dueAt)
            }
            ACTION_DISMISS -> {
                FollowUpStore.dismiss(context, id)
            }
        }
    }

    companion object {
        const val ACTION_CONFIRM = "com.contxt.app.ACTION_FOLLOWUP_CONFIRM"
        const val ACTION_DISMISS = "com.contxt.app.ACTION_FOLLOWUP_DISMISS"
        const val EXTRA_ID = "id"
        const val EXTRA_TASK = "task"
        const val EXTRA_CONTACT = "contact"
        const val EXTRA_DUE_HINT = "due_hint"
        const val EXTRA_DUE_AT = "due_at"
        const val EXTRA_NOTIF_ID = "notif_id"
    }
}
