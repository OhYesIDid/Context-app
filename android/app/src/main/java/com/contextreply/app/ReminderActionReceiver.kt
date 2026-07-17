package com.contextreply.app

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent

class ReminderActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val convKey = intent.getStringExtra(EXTRA_CONV_KEY) ?: return
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, -1)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notifId != -1) nm.cancel(notifId)

        when (intent.action) {
            ACTION_COPY -> {
                val suggestion = intent.getStringExtra(EXTRA_SUGGESTION) ?: return
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("suggested reply", suggestion))
                ContactMemory.saveLastSent(context, convKey, suggestion)
                ContactSignals.recordReply(context, convKey)
                NotificationStore.getInstance(context).markReplied(convKey)
            }
            ACTION_DISMISS -> {
                NotificationStore.getInstance(context).markReplied(convKey)
            }
        }
    }

    companion object {
        const val ACTION_COPY    = "com.contxt.app.ACTION_REMINDER_COPY"
        const val ACTION_DISMISS = "com.contxt.app.ACTION_REMINDER_DISMISS"
        const val EXTRA_CONV_KEY   = "conv_key"
        const val EXTRA_SUGGESTION = "suggestion"
        const val EXTRA_NOTIF_ID   = "notif_id"
    }
}
