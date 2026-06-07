package com.contextreply.app

import android.app.Activity
import android.app.PendingIntent
import android.os.Bundle

/**
 * Transparent, no-history activity used as a trampoline to fire a PendingIntent
 * from outside the bubble's embedded task. Activities without allowEmbedded=true
 * launched with FLAG_ACTIVITY_NEW_TASK from a bubble are placed in a normal task,
 * so the contentIntent fires into WhatsApp's own stack rather than the bubble's.
 */
class OpenChatTrampolineActivity : Activity() {

    companion object {
        var pendingChatIntent: PendingIntent? = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingChatIntent?.let { pi ->
            try { pi.send(this, 0, null) } catch (_: Exception) {}
            pendingChatIntent = null
        }
        finish()
    }
}
