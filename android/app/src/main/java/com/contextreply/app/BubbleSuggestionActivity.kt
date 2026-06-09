package com.contextreply.app

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

class BubbleSuggestionActivity : Activity() {

    companion object {
        // BgService sets this after the worker returns when the loading placeholder is showing.
        // The Activity invokes it on the UI thread and then nulls it out.
        @Volatile var onReplyReady: ((casual: String, formal: String?, brief: String?) -> Unit)? = null
    }

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
        val intentExtra     = intent.getStringExtra(ContextReplyBgService.EXTRA_INTENT)
        val messageExtra    = intent.getStringExtra(ContextReplyBgService.EXTRA_MESSAGE) ?: ""
        val intentsRaw      = intent.getStringExtra(ContextReplyBgService.EXTRA_INTENTS) ?: ""
        val detectedIntents = if (intentsRaw.isNotEmpty()) intentsRaw.split(",") else listOf("other")
        val preferredTone   = intent.getStringExtra(ContextReplyBgService.EXTRA_PREFERRED_TONE)
        @Suppress("DEPRECATION")
        val openChatIntent  = intent.getParcelableExtra<PendingIntent>(ContextReplyBgService.EXTRA_OPEN_CHAT_INTENT)
        val contact        = convKey?.substringAfter(":") ?: "Reply"

        val isLoading = casualText == ContextReplyBgService.LOADING_PLACEHOLDER

        // Mutable so Regenerate can update all tone variants in-place
        val textMap = mutableMapOf(
            "casual" to (if (isLoading) null else casualText),
            "formal" to formalText,
            "brief"  to briefText,
        )
        val available = if (isLoading) listOf("casual")
                        else toneKeys.filter { textMap[it]?.isNotEmpty() == true }
        if (available.isEmpty() && !isLoading) { finish(); return }

        var selectedIdx = if (preferredTone != null) available.indexOf(preferredTone).takeIf { it >= 0 } ?: available.indexOf("casual").coerceAtLeast(0)
                         else available.indexOf("casual").coerceAtLeast(0)

        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val PURPLE    = Color.parseColor("#6366f1")
        val PURPLE_BG = Color.parseColor("#6366f122")
        val TEXT      = Color.parseColor("#f4f4f5")
        val MUTED     = Color.parseColor("#71717a")
        val BG        = Color.parseColor("#1e1e22")

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }

        val packageName = convKey?.substringBefore(":") ?: ""

        val replyEdit = EditText(this).apply {
            setText(if (isLoading) "Drafting reply…" else textMap[available[selectedIdx]])
            setTextColor(if (isLoading) MUTED else TEXT)
            setHintTextColor(MUTED)
            textSize = 15f
            minLines = 2
            maxLines = 6
            isEnabled = !isLoading
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#27272a"))
                cornerRadius = dp(10).toFloat()
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            lp.bottomMargin = dp(16)
            layoutParams = lp
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }

        // Contact name — tappable if we have a contentIntent to open the conversation
        root.addView(TextView(this).apply {
            text = if (openChatIntent != null) "↗ $contact" else contact
            setTextColor(if (openChatIntent != null) PURPLE else MUTED)
            textSize = 12f
            setPadding(0, 0, 0, dp(10))
            if (openChatIntent != null) {
                setOnClickListener {
                    val selectedText = replyEdit.text.toString().trim().ifEmpty { textMap[available[selectedIdx]] ?: "" }
                    val a11yEnabled = isAccessibilityEnabled()
                    if (a11yEnabled && packageName.isNotEmpty() && selectedText.isNotEmpty()) {
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

        root.addView(replyEdit)

        // Tone tabs (only shown when more than one tone is available and not loading)
        val tabViews = mutableMapOf<String, TextView>()
        fun refreshTabs(activeIdx: Int) {
            tabViews.entries.forEachIndexed { i, (_, v) ->
                val active = i == activeIdx
                v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                v.setTextColor(if (active) PURPLE else MUTED)
                v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            }
        }

        if (!isLoading && available.size > 1) {
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
                tab.setOnClickListener {
                    selectedIdx = idx
                    replyEdit.setText(textMap[available[idx]])
                    replyEdit.setSelection(replyEdit.text.length)
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
            tabViews.entries.forEachIndexed { i, (_, v) ->
                val active = i == selectedIdx
                v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                v.setTextColor(if (active) PURPLE else MUTED)
                v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            }
            root.addView(tabRow)
        }

        // ── Intent context bar ───────────────────────────────────────────────
        val GREEN    = Color.parseColor("#22c55e")
        val GREEN_BG = Color.parseColor("#22c55e22")
        val intentLabels = mapOf("eta" to "ETA", "availability" to "Calendar", "booking" to "Bookings")
        val allKnownIntents = listOf("eta", "availability", "booking")
        val activeIntents = detectedIntents.filter { it != "other" }
        val unusedIntents = allKnownIntents.filter { it !in detectedIntents }

        fun makeChip(label: String, active: Boolean = true): TextView = TextView(this).apply {
            text = label
            setTextColor(if (active) PURPLE else GREEN)
            textSize = 11f
            setPadding(dp(8), dp(3), dp(8), dp(3))
            background = GradientDrawable().apply {
                setColor(if (active) PURPLE_BG else GREEN_BG)
                cornerRadius = dp(12).toFloat()
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.marginEnd = dp(6)
            layoutParams = lp
        }

        val intentBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dp(10)
            layoutParams = lp
        }

        if (activeIntents.isEmpty()) {
            intentBar.addView(TextView(this).apply {
                text = "No context"
                setTextColor(MUTED)
                textSize = 11f
            })
        } else {
            activeIntents.forEach { i -> intentBar.addView(makeChip(intentLabels[i] ?: i)) }
        }

        // Flex spacer
        intentBar.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        })

        val addContextRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dp(10)
            layoutParams = lp
        }

        if (unusedIntents.isNotEmpty()) {
            val addExpanded = booleanArrayOf(false)
            val addBtn = TextView(this).apply {
                text = "+ Context"
                setTextColor(MUTED)
                textSize = 11f
            }

            unusedIntents.forEach { i ->
                addContextRow.addView(makeChip("+ ${intentLabels[i] ?: i}", false).apply {
                    setOnClickListener {
                        logCorrection(detectedIntents, detectedIntents + i, messageExtra)
                        addBtn.text = "Noted"
                        addBtn.setTextColor(GREEN)
                        addContextRow.visibility = View.GONE
                    }
                })
            }

            addBtn.setOnClickListener {
                addExpanded[0] = !addExpanded[0]
                addContextRow.visibility = if (addExpanded[0]) View.VISIBLE else View.GONE
            }
            intentBar.addView(addBtn)
        }

        root.addView(intentBar)
        if (unusedIntents.isNotEmpty()) root.addView(addContextRow)

        // ── Action row: Dismiss · ↺ · Send ──────────────────────────────────
        val sendBtn = TextView(this@BubbleSuggestionActivity).apply {
            text = "Send"
            setTextColor(if (isLoading) MUTED else PURPLE)
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            isEnabled = !isLoading
            setOnClickListener {
                val text = replyEdit.text.toString().trim().ifEmpty { textMap[available[selectedIdx]] ?: casualText }
                sendAction(ContextReplyBgService.ACTION_SEND, text, remoteInputKey, notifId, convKey, intentExtra)
                finish()
            }
        }

        val regenBtn = TextView(this@BubbleSuggestionActivity).apply {
            text = "↺"
            setTextColor(MUTED)
            textSize = 16f
            setPadding(0, 0, dp(20), 0)
            isEnabled = !isLoading
            setOnClickListener {
                isEnabled = false
                replyEdit.setText("Regenerating…")
                replyEdit.isEnabled = false
                replyEdit.setTextColor(MUTED)
                sendBtn.isEnabled = false
                sendBtn.setTextColor(MUTED)
                Thread {
                    val thread = if (convKey != null)
                        NotificationStore.getInstance(this@BubbleSuggestionActivity).getThread(convKey)
                    else emptyList()
                    val result = WorkerClient.call(
                        this@BubbleSuggestionActivity,
                        messageExtra.ifEmpty { textMap["casual"] ?: "" },
                        thread,
                        regenerate = true,
                    )
                    val newCasual = result?.replies?.optString("casual")?.takeIf { it.isNotEmpty() }
                    val newFormal = result?.replies?.optString("formal")?.takeIf { it.isNotEmpty() }
                    val newBrief  = result?.replies?.optString("brief")?.takeIf { it.isNotEmpty() }
                    runOnUiThread {
                        if (newCasual != null) {
                            textMap["casual"] = newCasual
                            if (newFormal != null) textMap["formal"] = newFormal
                            if (newBrief  != null) textMap["brief"]  = newBrief
                        }
                        val currentTone = if (available.isNotEmpty()) available[selectedIdx] else "casual"
                        replyEdit.setText(textMap[currentTone] ?: replyEdit.text)
                        replyEdit.setTextColor(TEXT)
                        replyEdit.isEnabled = true
                        sendBtn.isEnabled = true
                        sendBtn.setTextColor(PURPLE)
                        isEnabled = true
                    }
                }.start()
            }
        }

        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 14f
                setPadding(0, 0, dp(20), 0)
                setOnClickListener {
                    // Use the current (possibly updated) casual text, never the loading placeholder
                    val dismissText = textMap["casual"]?.takeIf { it.isNotEmpty() } ?: ""
                    sendAction(ContextReplyBgService.ACTION_DISMISS, dismissText, null, notifId, convKey, null)
                    finish()
                }
            })

            addView(regenBtn)
            addView(sendBtn)
        })

        // Register for the reply-ready callback from BgService unconditionally —
        // the worker may complete after onCreate if the bubble was tapped early.
        onReplyReady = { casual, formal, brief ->
            runOnUiThread {
                onReplyReady = null
                textMap["casual"] = casual
                if (formal != null) textMap["formal"] = formal
                if (brief  != null) textMap["brief"]  = brief
                replyEdit.setText(casual)
                replyEdit.setTextColor(TEXT)
                replyEdit.isEnabled = true
                sendBtn.isEnabled = true
                sendBtn.setTextColor(PURPLE)
                regenBtn.isEnabled = true
            }
        }

        setContentView(root)
    }

    override fun onDestroy() {
        super.onDestroy()
        // Prevent a stale callback from running after the Activity is gone
        onReplyReady = null
    }

    private fun logCorrection(from: List<String>, to: List<String>, message: String) {
        val prefs = getSharedPreferences("contextreply_prefs", MODE_PRIVATE)
        val existing = prefs.getString("intent_corrections", "[]")
        val arr = try { JSONArray(existing) } catch (_: Exception) { JSONArray() }
        arr.put(JSONObject().apply {
            put("ts", System.currentTimeMillis())
            put("from", JSONArray().also { a -> from.forEach { a.put(it) } })
            put("to",   JSONArray().also { a -> to.forEach   { a.put(it) } })
            put("message", message.take(200))
        })
        val trimmed = if (arr.length() > 100) {
            JSONArray().also { a -> for (i in (arr.length() - 100) until arr.length()) a.put(arr.get(i)) }
        } else arr
        prefs.edit().putString("intent_corrections", trimmed.toString()).apply()
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.contains("${packageName}/com.contextreply.app.ContextReplyAccessibilityService")
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
