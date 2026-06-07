package com.contextreply.app

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

class BubbleSuggestionActivity : Activity() {

    private val toneKeys   = listOf("casual", "formal", "brief")
    private val toneLabels = listOf("Casual", "Formal", "Brief")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val casualText = intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_TEXT)
            ?: run { finish(); return }
        val formalText = intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_FORMAL)
            ?.takeIf { it.isNotEmpty() }
        val briefText  = intent.getStringExtra(ContextReplyBgService.EXTRA_REPLY_BRIEF)
            ?.takeIf { it.isNotEmpty() }
        val remoteInputKey = intent.getStringExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: run { finish(); return }
        val notifId    = intent.getIntExtra(ContextReplyBgService.EXTRA_NOTIF_ID, -1)
        val convKey    = intent.getStringExtra(ContextReplyBgService.EXTRA_CONV_KEY)
        val intentExtra    = intent.getStringExtra(ContextReplyBgService.EXTRA_INTENT)
        @Suppress("DEPRECATION")
        val openChatIntent = intent.getParcelableExtra<PendingIntent>(ContextReplyBgService.EXTRA_OPEN_CHAT_INTENT)
        val contact        = convKey?.substringAfter(":") ?: "Reply"

        val textMap = mapOf("casual" to casualText, "formal" to formalText, "brief" to briefText)
        val available = toneKeys.filter { textMap[it]?.isNotEmpty() == true }
        if (available.isEmpty()) { finish(); return }

        var selectedIdx = available.indexOf("casual").coerceAtLeast(0)

        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val PURPLE  = Color.parseColor("#6366f1")
        val PURPLE_BG = Color.parseColor("#6366f122")
        val TEXT    = Color.parseColor("#f4f4f5")
        val MUTED   = Color.parseColor("#71717a")
        val BG      = Color.parseColor("#1e1e22")

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }

        val packageName = convKey?.substringBefore(":") ?: ""

        // Contact name — tappable if we have a contentIntent to open the conversation
        root.addView(TextView(this).apply {
            text = if (openChatIntent != null) "↗ $contact" else contact
            setTextColor(if (openChatIntent != null) PURPLE else MUTED)
            textSize = 12f
            setPadding(0, 0, 0, dp(10))
            if (openChatIntent != null) {
                setOnClickListener {
                    val selectedText = textMap[available[selectedIdx]] ?: casualText
                    val a11yEnabled = isAccessibilityEnabled()
                    // Only write pending inject (and close the bubble) when the
                    // AccessibilityService is active — otherwise the user needs
                    // the bubble to stay open so they can copy/send manually.
                    if (a11yEnabled && packageName.isNotEmpty()) {
                        getSharedPreferences("contextreply_prefs", MODE_PRIVATE).edit()
                            .putString("pending_inject_$packageName", selectedText)
                            .apply()
                    }
                    sendBroadcast(
                        Intent(this@BubbleSuggestionActivity, ReplySendReceiver::class.java).apply {
                            action = ContextReplyBgService.ACTION_OPEN_CHAT
                            putExtra(ContextReplyBgService.EXTRA_OPEN_CHAT_INTENT, openChatIntent)
                            if (convKey != null) putExtra(ContextReplyBgService.EXTRA_CONV_KEY, convKey)
                        }
                    )
                    if (a11yEnabled) finish()
                }
            }
        })

        // Reply text (updates when tone tab changes)
        val replyView = TextView(this).apply {
            text = textMap[available[selectedIdx]]
            setTextColor(TEXT)
            textSize = 15f
            maxLines = 5
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, 0, 0, dp(16))
        }
        root.addView(replyView)

        // Tone tabs (only shown when more than one tone available)
        val tabViews = mutableMapOf<String, TextView>()
        if (available.size > 1) {
            val tabRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 0, 0, dp(16))
            }
            available.forEachIndexed { idx, tone ->
                val tab = TextView(this).apply {
                    text = toneLabels[toneKeys.indexOf(tone)]
                    textSize = 12f
                    setPadding(dp(10), dp(5), dp(10), dp(5))
                }
                fun refreshTabs(activeIdx: Int) {
                    tabViews.entries.forEachIndexed { i, (_, v) ->
                        val active = i == activeIdx
                        v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                        v.setTextColor(if (active) PURPLE else MUTED)
                        v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
                    }
                }
                tab.setOnClickListener {
                    selectedIdx = idx
                    replyView.text = textMap[available[idx]]
                    refreshTabs(idx)
                }
                tabViews[tone] = tab
                tabRow.addView(tab)
                if (idx < available.size - 1) {
                    tabRow.addView(TextView(this).apply {
                        text = " · "; textSize = 12f; setTextColor(Color.parseColor("#3f3f46"))
                    })
                }
            }
            // Set initial tab appearance
            tabViews.entries.forEachIndexed { i, (_, v) ->
                val active = i == selectedIdx
                v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                v.setTextColor(if (active) PURPLE else MUTED)
                v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            }
            root.addView(tabRow)
        }

        // Action row
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 14f
                setPadding(0, 0, dp(24), 0)
                setOnClickListener {
                    sendAction(ContextReplyBgService.ACTION_DISMISS, casualText, null, notifId, convKey, null)
                    finish()
                }
            })

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Send"
                setTextColor(PURPLE)
                textSize = 14f
                setTypeface(null, Typeface.BOLD)
                setOnClickListener {
                    val text = textMap[available[selectedIdx]] ?: casualText
                    sendAction(ContextReplyBgService.ACTION_SEND, text, remoteInputKey, notifId, convKey, intentExtra)
                    finish()
                }
            })
        })

        setContentView(root)
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.contains("com.contextreply.app/com.contextreply.app.ContextReplyAccessibilityService")
    }

    private fun sendAction(
        action: String, replyText: String?, remoteInputKey: String?,
        notifId: Int, convKey: String?, intentExtra: String?,
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
