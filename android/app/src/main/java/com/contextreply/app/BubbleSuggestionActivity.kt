package com.contextreply.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

class BubbleSuggestionActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val replyText = intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_TEXT)
            ?: run { finish(); return }
        val remoteInputKey = intent.getStringExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: run { finish(); return }
        val notifId = intent.getIntExtra(ContextReplyBgService.EXTRA_NOTIF_ID, -1)
        val convKey = intent.getStringExtra(ContextReplyBgService.EXTRA_CONV_KEY)
        val intentExtra = intent.getStringExtra(ContextReplyBgService.EXTRA_INTENT)

        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#1e1e22"))
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }

        root.addView(TextView(this).apply {
            text = replyText
            setTextColor(Color.parseColor("#f4f4f5"))
            textSize = 15f
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, 0, 0, dp(20))
        })

        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            weightSum = 0f

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Dismiss"
                setTextColor(Color.parseColor("#71717a"))
                textSize = 14f
                setPadding(0, 0, dp(24), 0)
                setOnClickListener { sendAction(ContextReplyBgService.ACTION_DISMISS, null, null, notifId, convKey, null); finish() }
            })

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Send"
                setTextColor(Color.parseColor("#6366f1"))
                textSize = 14f
                setTypeface(null, Typeface.BOLD)
                setOnClickListener { sendAction(ContextReplyBgService.ACTION_SEND, replyText, remoteInputKey, notifId, convKey, intentExtra); finish() }
            })
        })

        setContentView(root)
    }

    private fun sendAction(
        action: String,
        replyText: String?,
        remoteInputKey: String?,
        notifId: Int,
        convKey: String?,
        intentExtra: String?,
    ) {
        sendBroadcast(Intent(this, ReplySendReceiver::class.java).apply {
            this.action = action
            if (replyText != null) putExtra(ContextReplyBgService.EXTRA_REPLY_TEXT, replyText)
            if (remoteInputKey != null) putExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(ContextReplyBgService.EXTRA_NOTIF_ID, notifId)
            if (convKey != null) putExtra(ContextReplyBgService.EXTRA_CONV_KEY, convKey)
            if (intentExtra != null) putExtra(ContextReplyBgService.EXTRA_INTENT, intentExtra)
        })
    }
}
