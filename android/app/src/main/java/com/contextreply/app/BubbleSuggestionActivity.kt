package com.contextreply.app

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.Settings
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
        @Volatile var onReplyReady: ((casual: String, formal: String?, brief: String?, action: org.json.JSONObject?) -> Unit)? = null
    }

    private val toneKeys   = listOf("casual", "formal", "brief")
    private val toneLabels = listOf("Casual", "Formal", "Brief")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ── Extras ───────────────────────────────────────────────────────────
        val casualText = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_TEXT)
            ?: run { finish(); return }
        val formalText = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_FORMAL)?.takeIf { it.isNotEmpty() }
        val briefText  = intent.getStringExtra(ProTxtBgService.EXTRA_REPLY_BRIEF)?.takeIf { it.isNotEmpty() }
        val remoteInputKey = intent.getStringExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY)
            ?: run { finish(); return }
        val notifId         = intent.getIntExtra(ProTxtBgService.EXTRA_NOTIF_ID, -1)
        val convKey         = intent.getStringExtra(ProTxtBgService.EXTRA_CONV_KEY)
        val intentExtra     = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)
        val messageExtra    = intent.getStringExtra(ProTxtBgService.EXTRA_MESSAGE) ?: ""
        val intentsRaw      = intent.getStringExtra(ProTxtBgService.EXTRA_INTENTS) ?: ""
        val detectedIntents = if (intentsRaw.isNotEmpty()) intentsRaw.split(",") else listOf("other")
        val preferredTone   = intent.getStringExtra(ProTxtBgService.EXTRA_PREFERRED_TONE)
        @Suppress("DEPRECATION")
        val openChatIntent  = intent.getParcelableExtra<PendingIntent>(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT)
        val contact         = convKey?.substringAfter(":") ?: "Reply"
        val packageName     = convKey?.substringBefore(":") ?: ""
        val actionJson      = intent.getStringExtra(ProTxtBgService.EXTRA_ACTION_JSON)

        // ── State ─────────────────────────────────────────────────────────────
        val isLoading = casualText == ProTxtBgService.LOADING_PLACEHOLDER
        val suggestionTs = intent.getLongExtra(ProTxtBgService.EXTRA_SUGGESTION_TS, 0L)
        val staleThresholdMs = if (detectedIntents.any { it == "eta" || it == "availability" }) 5 * 60_000L else 30 * 60_000L
        val isStale = !isLoading && suggestionTs > 0L && System.currentTimeMillis() - suggestionTs > staleThresholdMs
        val showSkeleton = isLoading || isStale

        val textMap = mutableMapOf(
            "casual" to (if (isLoading) null else casualText),
            "formal" to formalText,
            "brief"  to briefText,
        )
        val available = if (isLoading) listOf("casual")
                        else toneKeys.filter { textMap[it]?.isNotEmpty() == true }
        if (available.isEmpty() && !isLoading) { finish(); return }

        var selectedIdx = if (preferredTone != null)
            available.indexOf(preferredTone).takeIf { it >= 0 } ?: available.indexOf("casual").coerceAtLeast(0)
        else available.indexOf("casual").coerceAtLeast(0)

        // ── Styling ───────────────────────────────────────────────────────────
        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val PURPLE    = Color.parseColor("#6366f1")
        val PURPLE_BG = Color.parseColor("#6366f122")
        val TEXT      = Color.parseColor("#f4f4f5")
        val MUTED     = Color.parseColor("#71717a")
        val BG        = Color.parseColor("#1e1e22")
        val SURFACE2  = Color.parseColor("#27272a")
        val BORDER    = Color.parseColor("#3f3f46")
        val GREEN     = Color.parseColor("#22c55e")
        val GREEN_BG  = Color.parseColor("#22c55e22")

        val AVATAR_PALETTE = listOf(0xFF6366f1L, 0xFF8b5cf6L, 0xFFec4899L, 0xFFf43f5eL,
                                    0xFFf59e0bL, 0xFF10b981L, 0xFF06b6d4L, 0xFF3b82f6L)
        val avatarColor = AVATAR_PALETTE[contact.hashCode().and(0x7FFFFFFF) % AVATAR_PALETTE.size].toInt()

        // ── Early view declarations (referenced across closures) ───────────────
        val replyEdit = EditText(this).apply {
            setText(if (showSkeleton) "" else textMap[available[selectedIdx]])
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            textSize = 15f
            minLines = 2
            maxLines = 6
            isEnabled = !showSkeleton
            background = GradientDrawable().apply {
                setColor(SURFACE2)
                cornerRadius = dp(10).toFloat()
            }
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(14)
            layoutParams = lp
            setPadding(dp(12), dp(10), dp(12), dp(10))
            visibility = if (showSkeleton) View.GONE else View.VISIBLE
        }

        var regenBtn: TextView? = null

        val suggestedAction = if (actionJson != null && !isLoading) {
            try { JSONObject(actionJson) } catch (_: Exception) { null }
        } else null

        val sendBtn = TextView(this).apply {
            text = "Send"
            setTextColor(if (showSkeleton) MUTED else Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setTypeface(null, Typeface.BOLD)
            isEnabled = !showSkeleton
            background = GradientDrawable().apply {
                setColor(if (showSkeleton) SURFACE2 else PURPLE)
                cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(16), dp(13), dp(16), dp(13))
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(12)
            lp.bottomMargin = dp(8)
            layoutParams = lp
            setOnClickListener {
                val text = replyEdit.text.toString().trim().ifEmpty { textMap[available[selectedIdx]] ?: casualText }
                sendAction(ProTxtBgService.ACTION_SEND, text, remoteInputKey, notifId, convKey, intentExtra)
                if (suggestedAction != null) postActionFollowUp(suggestedAction, convKey, notifId)
                finish()
            }
        }

        // Skeleton animators — cancelled when loading finishes
        val skeletonAnimators = mutableListOf<ObjectAnimator>()

        val skeletonContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(SURFACE2)
                cornerRadius = dp(10).toFloat()
            }
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(14)
            layoutParams = lp
            visibility = if (showSkeleton) View.VISIBLE else View.GONE
        }
        listOf(LinearLayout.LayoutParams.MATCH_PARENT, dp(140)).forEachIndexed { i, w ->
            val line = View(this).apply {
                background = GradientDrawable().apply {
                    setColor(BORDER)
                    cornerRadius = dp(4).toFloat()
                }
                val lp2 = LinearLayout.LayoutParams(w, dp(13))
                if (i == 0) lp2.bottomMargin = dp(8)
                layoutParams = lp2
            }
            skeletonContainer.addView(line)
            val anim = ObjectAnimator.ofFloat(line, "alpha", 0.3f, 1f).apply {
                duration = 850
                repeatCount = ValueAnimator.INFINITE
                repeatMode = ValueAnimator.REVERSE
                startDelay = (i * 170).toLong()
            }
            anim.start()
            skeletonAnimators.add(anim)
        }

        val actionContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }

        // ── Helpers ───────────────────────────────────────────────────────────
        fun doOpenChat() {
            if (openChatIntent == null) return
            val selectedText = replyEdit.text.toString().trim().ifEmpty { textMap[available[selectedIdx]] ?: "" }
            val a11yEnabled = isAccessibilityEnabled()
            if (a11yEnabled && packageName.isNotEmpty() && selectedText.isNotEmpty()) {
                Prefs.main(this).edit()
                    .putString("pending_inject_$packageName", selectedText).apply()
            }
            sendBroadcast(Intent(this, ReplySendReceiver::class.java).apply {
                action = ProTxtBgService.ACTION_OPEN_CHAT
                putExtra(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT, openChatIntent)
                if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
            }, "com.contxt.app.INTERNAL_BROADCAST")
            if (a11yEnabled) finish()
        }

        fun restartSkeletonAnimations() {
            skeletonAnimators.forEach { it.cancel() }
            skeletonAnimators.clear()
            for (i in 0 until skeletonContainer.childCount) {
                val line = skeletonContainer.getChildAt(i)
                line.alpha = 1f
                val anim = ObjectAnimator.ofFloat(line, "alpha", 0.3f, 1f).apply {
                    duration = 850
                    repeatCount = ValueAnimator.INFINITE
                    repeatMode = ValueAnimator.REVERSE
                    startDelay = (i * 170).toLong()
                }
                anim.start()
                skeletonAnimators.add(anim)
            }
        }

        fun triggerRegen() {
            regenBtn?.isEnabled = false
            restartSkeletonAnimations()
            skeletonContainer.visibility = View.VISIBLE
            replyEdit.visibility = View.GONE
            replyEdit.isEnabled = false
            sendBtn.isEnabled = false
            sendBtn.setTextColor(MUTED)
            (sendBtn.background as? GradientDrawable)?.setColor(SURFACE2)
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
                    skeletonAnimators.forEach { it.cancel() }
                    skeletonAnimators.clear()
                    skeletonContainer.visibility = View.GONE
                    replyEdit.visibility = View.VISIBLE
                    replyEdit.setText(textMap[currentTone] ?: replyEdit.text)
                    replyEdit.setTextColor(TEXT)
                    replyEdit.isEnabled = true
                    sendBtn.isEnabled = true
                    sendBtn.setTextColor(Color.WHITE)
                    (sendBtn.background as? GradientDrawable)?.setColor(PURPLE)
                    regenBtn?.isEnabled = true
                }
            }.start()
        }

        // ── Root ──────────────────────────────────────────────────────────────
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }

        // ── Header: avatar + name + platform ─────────────────────────────────
        val platformLabel = when (packageName) {
            "com.whatsapp", "com.whatsapp.w4b"   -> "WhatsApp"
            "org.telegram.messenger"              -> "Telegram"
            "com.facebook.orca"                  -> "Messenger"
            "org.thoughtcrime.securesms"          -> "Signal"
            "com.google.android.apps.messaging"  -> "Messages"
            "com.instagram.android"              -> "Instagram"
            else                                 -> null
        }

        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(14)
            layoutParams = lp

            // Avatar circle with contact initial
            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = contact.firstOrNull()?.uppercase() ?: "?"
                setTextColor(Color.WHITE)
                textSize = 15f
                gravity = Gravity.CENTER
                setTypeface(null, Typeface.BOLD)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(avatarColor)
                }
                val lp2 = LinearLayout.LayoutParams(dp(38), dp(38))
                lp2.marginEnd = dp(10)
                layoutParams = lp2
                if (openChatIntent != null) setOnClickListener { doOpenChat() }
            })

            // Contact name + platform label
            addView(LinearLayout(this@BubbleSuggestionActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(TextView(this@BubbleSuggestionActivity).apply {
                    text = contact.take(28)
                    setTextColor(TEXT)
                    textSize = 15f
                    setTypeface(null, Typeface.BOLD)
                })
                if (platformLabel != null) {
                    addView(TextView(this@BubbleSuggestionActivity).apply {
                        text = platformLabel
                        setTextColor(MUTED)
                        textSize = 11f
                    })
                }
            })

            // Open-chat arrow
            if (openChatIntent != null) {
                addView(TextView(this@BubbleSuggestionActivity).apply {
                    text = "↗"
                    setTextColor(PURPLE)
                    textSize = 16f
                    setPadding(dp(8), 0, 0, 0)
                    setOnClickListener { doOpenChat() }
                })
            }
        })

        // ── Incoming message quote ────────────────────────────────────────────
        if (messageExtra.isNotEmpty()) {
            root.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(12)
                layoutParams = lp

                addView(View(this@BubbleSuggestionActivity).apply {
                    background = GradientDrawable().apply { setColor(BORDER) }
                    layoutParams = LinearLayout.LayoutParams(dp(3), LinearLayout.LayoutParams.MATCH_PARENT).apply {
                        marginEnd = dp(9)
                    }
                })

                addView(TextView(this@BubbleSuggestionActivity).apply {
                    text = messageExtra
                    setTextColor(MUTED)
                    textSize = 13f
                    maxLines = 3
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setLineSpacing(0f, 1.25f)
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                })
            })
        }

        // ── Contact match banner ──────────────────────────────────────────────
        val contactMatchJson = intent.getStringExtra(ProTxtBgService.EXTRA_CONTACT_MATCH_JSON)
        val contactMatch = if (contactMatchJson != null) {
            try { JSONObject(contactMatchJson) } catch (_: Exception) { null }
        } else null

        val refreshTabsFn = arrayOfNulls<((Int) -> Unit)>(1)

        if (contactMatch != null) {
            val matchName      = contactMatch.optString("displayName")
            val matchContactId = contactMatch.optString("contactId")
            val matchTone      = contactMatch.optString("preferredTone").ifEmpty { null }
            val matchConfidence = contactMatch.optDouble("confidence", 0.0)
            val isHighConf = matchConfidence >= 0.88
            val AMBER    = Color.parseColor(if (isHighConf) "#f59e0b" else "#d97706")
            val AMBER_BG = Color.parseColor(if (isHighConf) "#f59e0b18" else "#d9770610")
            val bannerText = if (isHighConf) "Is this $matchName?" else "Possibly $matchName?"

            val banner = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = GradientDrawable().apply {
                    setColor(AMBER_BG)
                    cornerRadius = dp(8).toFloat()
                    setStroke(1, Color.parseColor(if (isHighConf) "#f59e0b44" else "#d9770630"))
                }
                setPadding(dp(10), dp(7), dp(10), dp(7))
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }

            banner.addView(TextView(this).apply {
                text = bannerText
                setTextColor(AMBER)
                textSize = 12f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })

            fun confirmMatch() {
                val prefs = Prefs.main(this)
                val confirmed = try {
                    JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
                } catch (_: Exception) { JSONObject() }
                if (convKey != null) confirmed.put(convKey, matchContactId)
                prefs.edit().putString("confirmed_identities", confirmed.toString()).apply()
                if (matchTone != null && !isLoading) {
                    val toneIdx = available.indexOf(matchTone)
                    if (toneIdx >= 0) {
                        selectedIdx = toneIdx
                        replyEdit.setText(textMap[available[toneIdx]])
                        replyEdit.setSelection(replyEdit.text.length)
                        refreshTabsFn[0]?.invoke(toneIdx)
                    }
                }
                banner.visibility = View.GONE
            }

            banner.addView(TextView(this).apply {
                text = "Yes"
                setTextColor(AMBER)
                textSize = 12f
                setTypeface(null, Typeface.BOLD)
                setPadding(dp(12), dp(4), dp(6), dp(4))
                setOnClickListener { confirmMatch() }
            })
            banner.addView(TextView(this).apply {
                text = "No"
                setTextColor(MUTED)
                textSize = 12f
                setPadding(dp(6), dp(4), 0, dp(4))
                setOnClickListener { banner.visibility = View.GONE }
            })
            root.addView(banner)
        }

        // ── Reply area: edit text (ready) or skeleton (loading) ───────────────
        root.addView(replyEdit)
        root.addView(skeletonContainer)

        // ── Tone pills ────────────────────────────────────────────────────────
        val tabViews = mutableMapOf<String, TextView>()
        fun refreshTabs(activeIdx: Int) {
            tabViews.entries.forEachIndexed { i, (_, v) ->
                val active = i == activeIdx
                v.background = GradientDrawable().apply {
                    setColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                    cornerRadius = dp(20).toFloat()
                    setStroke(1, if (active) PURPLE else BORDER)
                }
                v.setTextColor(if (active) PURPLE else MUTED)
                v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            }
        }
        refreshTabsFn[0] = ::refreshTabs

        if (!showSkeleton && available.size > 1) {
            val tabRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(14)
                layoutParams = lp
            }
            available.forEachIndexed { idx, tone ->
                val tab = TextView(this).apply {
                    text = toneLabels[toneKeys.indexOf(tone)]
                    textSize = 12f
                    gravity = Gravity.CENTER
                    setPadding(dp(10), dp(6), dp(10), dp(6))
                    val lp2 = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    if (idx < available.size - 1) lp2.marginEnd = dp(6)
                    layoutParams = lp2
                }
                tab.setOnClickListener {
                    selectedIdx = idx
                    replyEdit.setText(textMap[available[idx]])
                    replyEdit.setSelection(replyEdit.text.length)
                    refreshTabs(idx)
                }
                tabViews[tone] = tab
                tabRow.addView(tab)
            }
            refreshTabs(selectedIdx)
            root.addView(tabRow)
        }

        // ── Intent context bar ────────────────────────────────────────────────
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
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.marginEnd = dp(6)
            layoutParams = lp
        }

        val intentBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(10)
            layoutParams = lp
        }
        activeIntents.forEach { i -> intentBar.addView(makeChip(intentLabels[i] ?: i)) }
        intentBar.addView(View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })

        val addContextRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
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

        // ── Action area ───────────────────────────────────────────────────────
        root.addView(actionContainer)

        fun showActionCTA(action: JSONObject) {
            val actionType  = action.optString("type")
            val actionLabel = action.optString("label").ifEmpty { null } ?: return
            actionContainer.removeAllViews()
            actionContainer.addView(TextView(this@BubbleSuggestionActivity).apply {
                text = actionLabel
                setTextColor(GREEN)
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(8), dp(12), dp(8))
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#22c55e1a"))
                    cornerRadius = dp(8).toFloat()
                    setStroke(1, Color.parseColor("#22c55e44"))
                }
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
                setOnClickListener {
                    logActionFeedback("tapped", actionType, convKey)
                    when (actionType) {
                        "calendar_add" -> {
                            val title = action.optString("title").ifEmpty { "Event" }
                            val datetimeStr = action.optString("datetime").ifEmpty { null }
                            val duration = action.optInt("durationMinutes", 60)
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
                            val address = action.optString("address").ifEmpty { null } ?: return@setOnClickListener
                            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(address)}"))) } catch (_: Exception) {}
                        }
                        "share_location" -> {
                            var lat = action.optDouble("lat", Double.NaN)
                            var lon = action.optDouble("lon", Double.NaN)
                            val area = action.optString("area").ifEmpty { null }
                            if (lat.isNaN() || lon.isNaN()) {
                                ProTxtBgService.getInstance()?.getLastLocation()?.let { loc ->
                                    lat = loc.latitude; lon = loc.longitude
                                }
                            }
                            if (!lat.isNaN() && !lon.isNaN()) {
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
            actionContainer.visibility = View.VISIBLE
        }

        if (suggestedAction != null) {
            showActionCTA(suggestedAction)
        } else if (!isLoading) {
            val addActionBtn = TextView(this).apply {
                text = "+ Action"
                setTextColor(MUTED)
                textSize = 11f
            }
            val addActionExpanded = booleanArrayOf(false)
            val addActionRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                visibility = View.GONE
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }
            addActionRow.addView(makeChip("+ Calendar", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_calendar", "calendar_add", convKey)
                    try { startActivity(Intent(Intent.ACTION_INSERT).apply { data = CalendarContract.Events.CONTENT_URI }) } catch (_: Exception) {}
                    addActionBtn.text = "Noted"; addActionBtn.setTextColor(GREEN)
                    addActionRow.visibility = View.GONE
                }
            })
            addActionRow.addView(makeChip("+ Maps", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_maps", "maps_open", convKey)
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0"))) } catch (_: Exception) {}
                    addActionBtn.text = "Noted"; addActionBtn.setTextColor(GREEN)
                    addActionRow.visibility = View.GONE
                }
            })
            addActionRow.addView(makeChip("+ Location", false).apply {
                setOnClickListener {
                    logActionFeedback("requested_share_location", "share_location", convKey)
                    val loc = ProTxtBgService.getInstance()?.getLastLocation()
                    if (loc != null) {
                        addActionBtn.text = "Noted"; addActionBtn.setTextColor(GREEN)
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
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(6)
                layoutParams = lp
            }
            addActionBar.addView(View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })
            addActionBar.addView(addActionBtn)
            root.addView(addActionBar)
            root.addView(addActionRow)
        }

        // ── Primary Send button ───────────────────────────────────────────────
        root.addView(sendBtn)

        // ── Secondary row: No reply · [spacer] · Dismiss · ↺ ─────────────────
        regenBtn = TextView(this).apply {
            text = "↺"
            setTextColor(MUTED)
            textSize = 16f
            isEnabled = !showSkeleton
            setOnClickListener { triggerRegen() }
        }

        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Mark as read"
                setTextColor(MUTED)
                textSize = 13f
                setPadding(0, 0, dp(14), 0)
                setOnClickListener {
                    sendBroadcast(Intent(this@BubbleSuggestionActivity, ReplySendReceiver::class.java).apply {
                        action = ProTxtBgService.ACTION_MARK_READ
                        putExtra(ProTxtBgService.EXTRA_NOTIF_ID, notifId)
                        if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
                    }, "com.contxt.app.INTERNAL_BROADCAST")
                    finish()
                }
            })

            addView(View(this@BubbleSuggestionActivity).apply {
                layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
            })

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 13f
                setPadding(0, 0, dp(20), 0)
                setOnClickListener {
                    val dismissText = textMap["casual"]?.takeIf { it.isNotEmpty() } ?: ""
                    sendAction(ProTxtBgService.ACTION_DISMISS, dismissText, null, notifId, convKey, null)
                    finish()
                }
            })

            addView(regenBtn)
        })

        // ── onReplyReady: invoked by BgService when worker finishes ───────────
        onReplyReady = { casual, formal, brief, action ->
            runOnUiThread {
                onReplyReady = null
                textMap["casual"] = casual
                if (formal != null) textMap["formal"] = formal
                if (brief  != null) textMap["brief"]  = brief
                skeletonAnimators.forEach { it.cancel() }
                skeletonAnimators.clear()
                skeletonContainer.visibility = View.GONE
                replyEdit.visibility = View.VISIBLE
                replyEdit.setText(casual)
                replyEdit.setTextColor(TEXT)
                replyEdit.isEnabled = true
                sendBtn.isEnabled = true
                sendBtn.setTextColor(Color.WHITE)
                (sendBtn.background as? GradientDrawable)?.setColor(PURPLE)
                regenBtn?.isEnabled = true
                if (action != null) showActionCTA(action)
            }
        }

        if (isStale) triggerRegen()

        setContentView(root)
    }

    override fun onDestroy() {
        super.onDestroy()
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
        val prefs = Prefs.main(this)
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
        val prefs = Prefs.main(this)
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
        }, "com.contxt.app.INTERNAL_BROADCAST")
    }
}
