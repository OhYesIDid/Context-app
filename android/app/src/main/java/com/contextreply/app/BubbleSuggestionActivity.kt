package com.contextreply.app

import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.Settings
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

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

        val casualText = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
            ?: run { finish(); return }
        val formalText = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_FORMAL)
            ?.takeIf { it.isNotEmpty() }
        val briefText  = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_BRIEF)
            ?.takeIf { it.isNotEmpty() }
        val remoteInputKey = intent.getStringExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: run { finish(); return }
        val notifId    = intent.getIntExtra(ProTxtBgService.EXTRA_NOTIF_ID, -1)
        val convKey    = intent.getStringExtra(ProTxtBgService.EXTRA_CONV_KEY)
        val intentExtra     = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)
        val messageExtra    = intent.getStringExtra(ProTxtBgService.EXTRA_MESSAGE) ?: ""
        val intentsRaw      = intent.getStringExtra(ProTxtBgService.EXTRA_INTENTS) ?: ""
        val detectedIntents = if (intentsRaw.isNotEmpty()) intentsRaw.split(",") else listOf("other")
        val preferredTone   = intent.getStringExtra(ProTxtBgService.EXTRA_PREFERRED_TONE)
        @Suppress("DEPRECATION")
        val openChatIntent  = intent.getParcelableExtra<PendingIntent>(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT)
        val contact        = convKey?.substringAfter(":") ?: "Reply"

        val isLoading = casualText == ProTxtBgService.LOADING_PLACEHOLDER

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
                            action = ProTxtBgService.ACTION_OPEN_CHAT
                            putExtra(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT, openChatIntent)
                            if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
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
        val intentLabels = mapOf("eta" to "ETA", "availability" to "Calendar")
        val allKnownIntents = listOf("eta", "availability")
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
            // No enriched context for this message — leave the bar empty rather than
            // showing "No context" which reads as an error state.
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

        // ── Suggested action button (calendar, maps) ─────────────────────────
        val actionJson = intent.getStringExtra(ProTxtBgService.EXTRA_ACTION_JSON)
        val suggestedAction = if (actionJson != null && !isLoading) {
            try { JSONObject(actionJson) } catch (_: Exception) { null }
        } else null

        if (suggestedAction != null) {
            val actionType  = suggestedAction.optString("type")
            val actionLabel = suggestedAction.optString("label").ifEmpty { null }
            if (actionLabel != null) {
                root.addView(TextView(this).apply {
                    text = actionLabel
                    setTextColor(Color.parseColor("#22c55e"))
                    textSize = 13f
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(8), dp(12), dp(8))
                    background = GradientDrawable().apply {
                        setColor(Color.parseColor("#22c55e1a"))
                        cornerRadius = dp(8).toFloat()
                        setStroke(1, Color.parseColor("#22c55e44"))
                    }
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.bottomMargin = dp(10)
                    layoutParams = lp
                    setOnClickListener {
                        logActionFeedback("tapped", actionType, convKey)
                        when (actionType) {
                            "calendar_add" -> {
                                val title = suggestedAction.optString("title").ifEmpty { "Event" }
                                val datetimeStr = suggestedAction.optString("datetime").ifEmpty { null }
                                val duration = suggestedAction.optInt("durationMinutes", 60)
                                val calIntent = Intent(Intent.ACTION_INSERT).apply {
                                    data = CalendarContract.Events.CONTENT_URI
                                    putExtra(CalendarContract.Events.TITLE, title)
                                    if (datetimeStr != null) {
                                        try {
                                            val startMs = LocalDateTime.parse(datetimeStr)
                                                .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
                                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMs + duration * 60_000L)
                                        } catch (_: Exception) {}
                                    }
                                }
                                try { startActivity(calIntent) } catch (_: Exception) {}
                            }
                            "maps_open" -> {
                                val address = suggestedAction.optString("address").ifEmpty { null } ?: return@setOnClickListener
                                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(address)}"))) } catch (_: Exception) {}
                            }
                            "share_location" -> {
                                val lat = suggestedAction.optDouble("lat", Double.NaN)
                                val lon = suggestedAction.optDouble("lon", Double.NaN)
                                if (!lat.isNaN() && !lon.isNaN()) {
                                    val area = suggestedAction.optString("area").ifEmpty { null }
                                    val mapsUrl = "https://maps.google.com/?q=$lat,$lon"
                                    val msg = if (area != null) "I'm currently in $area: $mapsUrl" else mapsUrl
                                    sendAction(ProTxtBgService.ACTION_SEND, msg, remoteInputKey, notifId, convKey, intentExtra)
                                    finish()
                                } else {
                                    android.widget.Toast.makeText(this@BubbleSuggestionActivity, "Location not available yet", android.widget.Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    }
                })
            }
        } else if (!isLoading) {
            // No action detected — mirrors "+ Context" pattern: collapsed by default
            val addActionBtn = TextView(this).apply {
                text = "+ Action"
                setTextColor(MUTED)
                textSize = 11f
            }
            val addActionExpanded = booleanArrayOf(false)
            val addActionRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                visibility = View.GONE
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }
            addActionRow.addView(makeChip("+ Calendar", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_calendar", "calendar_add", convKey)
                    try { startActivity(Intent(Intent.ACTION_INSERT).apply { data = CalendarContract.Events.CONTENT_URI }) } catch (_: Exception) {}
                    addActionBtn.text = "Noted"
                    addActionBtn.setTextColor(GREEN)
                    addActionRow.visibility = View.GONE
                }
            })
            addActionRow.addView(makeChip("+ Maps", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_maps", "maps_open", convKey)
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0"))) } catch (_: Exception) {}
                    addActionBtn.text = "Noted"
                    addActionBtn.setTextColor(GREEN)
                    addActionRow.visibility = View.GONE
                }
            })
            addActionRow.addView(makeChip("+ Location", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_share_location", "share_location", convKey)
                    val loc = ProTxtBgService.getInstance()?.getLastLocation()
                    if (loc != null) {
                        addActionBtn.text = "Noted"
                        addActionBtn.setTextColor(GREEN)
                        addActionRow.visibility = View.GONE
                        Thread {
                            val geocoder = android.location.Geocoder(this@BubbleSuggestionActivity, java.util.Locale.getDefault())
                            @Suppress("DEPRECATION")
                            val area = try {
                                geocoder.getFromLocation(loc.latitude, loc.longitude, 1)
                                    ?.firstOrNull()?.let { it.subLocality ?: it.locality ?: it.thoroughfare }
                            } catch (_: Exception) { null }
                            val mapsUrl = "https://maps.google.com/?q=${loc.latitude},${loc.longitude}"
                            val msg = if (area != null) "I'm currently in $area: $mapsUrl" else mapsUrl
                            runOnUiThread { sendAction(ProTxtBgService.ACTION_SEND, msg, remoteInputKey, notifId, convKey, intentExtra); finish() }
                        }.start()
                    } else {
                        android.widget.Toast.makeText(this@BubbleSuggestionActivity, "Location not available yet", android.widget.Toast.LENGTH_SHORT).show()
                    }
                }
            })
            addActionBtn.setOnClickListener {
                addActionExpanded[0] = !addActionExpanded[0]
                addActionRow.visibility = if (addActionExpanded[0]) View.VISIBLE else View.GONE
            }
            val addActionBar = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.bottomMargin = dp(6)
                layoutParams = lp
            }
            addActionBar.addView(View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })
            addActionBar.addView(addActionBtn)
            root.addView(addActionBar)
            root.addView(addActionRow)
        }

        // ── Action row: Dismiss · ↺ · Send ──────────────────────────────────
        val sendBtn = TextView(this@BubbleSuggestionActivity).apply {
            text = "Send"
            setTextColor(if (isLoading) MUTED else PURPLE)
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            isEnabled = !isLoading
            setOnClickListener {
                val text = replyEdit.text.toString().trim().ifEmpty { textMap[available[selectedIdx]] ?: casualText }
                sendAction(ProTxtBgService.ACTION_SEND, text, remoteInputKey, notifId, convKey, intentExtra)
                if (suggestedAction != null) postActionFollowUp(suggestedAction, convKey, notifId)
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
                    val contactMemory = if (convKey != null)
                        ContactMemory.getMemory(this@BubbleSuggestionActivity, convKey) else null
                    val lastSent = if (convKey != null)
                        ContactMemory.getLastSent(this@BubbleSuggestionActivity, convKey) else null
                    val result = WorkerClient.call(
                        this@BubbleSuggestionActivity,
                        messageExtra.ifEmpty { textMap["casual"] ?: "" },
                        thread,
                        regenerate = true,
                        contactMemory = contactMemory,
                        lastSentReply = lastSent,
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
                    sendAction(ProTxtBgService.ACTION_DISMISS, dismissText, null, notifId, convKey, null)
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

    private fun postActionFollowUp(action: JSONObject, convKey: String?, notifId: Int) {
        val actionType  = action.optString("type")
        val actionLabel = action.optString("label").ifEmpty { null } ?: return

        var bodyText = ""
        val actionIntent = when (actionType) {
            "calendar_add" -> {
                val title       = action.optString("title").ifEmpty { "Event" }
                val datetimeStr = action.optString("datetime").ifEmpty { null }
                val duration    = action.optInt("durationMinutes", 60)
                bodyText = buildCalendarBody(title, datetimeStr, duration)
                Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    if (datetimeStr != null) {
                        try {
                            val startMs = LocalDateTime.parse(datetimeStr)
                                .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMs + duration * 60_000L)
                        } catch (_: Exception) {}
                    }
                }
            }
            "maps_open" -> {
                val address = action.optString("address").ifEmpty { null } ?: return
                bodyText = address
                Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(address)}"))
            }
            else -> return
        }

        val followUpId = "${convKey}_action".hashCode().and(0x7FFFFFFF)
        val pi = PendingIntent.getActivity(
            this, followUpId, actionIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, ProTxtBgService.CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher_round)
            .setContentTitle(actionLabel)
            .setContentText(bodyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyText))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setTimeoutAfter(5 * 60 * 1000L)
            .build()
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(followUpId, notification)
    }

    private fun buildCalendarBody(title: String, datetimeStr: String?, durationMinutes: Int): String {
        if (datetimeStr == null) return title
        return try {
            val dt = LocalDateTime.parse(datetimeStr)
            val datePart = dt.toLocalDate().let { d ->
                val dow = d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
                val month = d.month.getDisplayName(TextStyle.SHORT, Locale.getDefault())
                "$dow ${d.dayOfMonth} $month"
            }
            val timePart = dt.toLocalTime().let { t ->
                val h = if (t.hour % 12 == 0) 12 else t.hour % 12
                val m = t.minute.toString().padStart(2, '0')
                val ampm = if (t.hour < 12) "AM" else "PM"
                "$h:$m $ampm"
            }
            val durationPart = when {
                durationMinutes < 60  -> "${durationMinutes}min"
                durationMinutes == 60 -> "1 hour"
                durationMinutes % 60 == 0 -> "${durationMinutes / 60} hours"
                else -> "${durationMinutes / 60}h ${durationMinutes % 60}min"
            }
            "$title · $datePart · $timePart · $durationPart"
        } catch (_: Exception) {
            title
        }
    }

    private fun logActionFeedback(event: String, actionType: String, convKey: String?) {
        val prefs = getSharedPreferences("contextreply_prefs", MODE_PRIVATE)
        val existing = prefs.getString("action_feedback", "[]")
        val arr = try { JSONArray(existing) } catch (_: Exception) { JSONArray() }
        arr.put(JSONObject().apply {
            put("ts", System.currentTimeMillis())
            put("event", event)
            put("actionType", actionType)
            if (convKey != null) put("convKey", convKey)
        })
        val trimmed = if (arr.length() > 100) {
            JSONArray().also { a -> for (i in (arr.length() - 100) until arr.length()) a.put(arr.get(i)) }
        } else arr
        prefs.edit().putString("action_feedback", trimmed.toString()).apply()
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
        return enabled.contains("${packageName}/com.contextreply.app.ProTxtAccessibilityService")
    }

    private fun sendAction(
        action: String, replyText: String?, remoteInputKey: String?,
        notifId: Int, convKey: String?, intentExtra: String?,
    ) {
        sendBroadcast(Intent(this, ReplySendReceiver::class.java).apply {
            this.action = action
            if (replyText != null) putExtra(ProTxtBgService.EXTRA_REPLY_TEXT, replyText)
            if (remoteInputKey != null) putExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(ProTxtBgService.EXTRA_NOTIF_ID, notifId)
            if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
            if (intentExtra != null) putExtra(ProTxtBgService.EXTRA_INTENT, intentExtra)
        })
    }
}
