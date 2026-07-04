package com.contextreply.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class HomeConfirmReceiver : BroadcastReceiver() {

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == ACTION_DISMISS) {
            HomeDetectionWorker.dismissCandidate(ctx)
        }
    }

    companion object {
        const val ACTION_DISMISS = "com.contxt.app.ACTION_HOME_DISMISS"
    }
}
