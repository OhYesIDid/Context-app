package com.contextreply.app

import android.animation.ArgbEvaluator
import android.animation.LayoutTransition
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.view.animation.OvershootInterpolator
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
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.Settings
import android.widget.ScrollView
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class BubbleSuggestionActivity : Activity() {

    companion object {
        // Keyed by convKey — with up to 6 bubbles open at once, a single shared
        // callback slot would let one bubble's registration silently clobber another's,
        // leaving the earlier bubble stuck on its loading state forever.
        val onReplyReady = ConcurrentHashMap<String, (casual: String, formal: String?, brief: String?, action: org.json.JSONObject?) -> Unit>()
        // A bubble's expanded Activity is never recreated when the system re-shows it —
        // there's no onNewIntent for bubbles, so a message that arrives while this
        // Activity is already open/alive must reach it through this side channel instead.
        // Fired when the bg service starts a new worker job for an already-open bubble's
        // convKey, so it can flip back to a loading state and show the new message.
        val onNewJobStarted = ConcurrentHashMap<String, (latestMessage: String) -> Unit>()
    }

    private val toneKeys   = listOf("casual", "formal", "brief")
    private val toneLabels = listOf("Casual", "Formal", "Brief")
    private var myConvKey: String? = null

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
        myConvKey           = convKey
        val intentExtra     = intent.getStringExtra(ProTxtBgService.EXTRA_INTENT)
        val messageExtra    = intent.getStringExtra(ProTxtBgService.EXTRA_MESSAGE) ?: ""
        val intentsRaw      = intent.getStringExtra(ProTxtBgService.EXTRA_INTENTS) ?: ""
        val detectedIntents = if (intentsRaw.isNotEmpty()) intentsRaw.split(",") else listOf("other")
        val preferredTone   = intent.getStringExtra(ProTxtBgService.EXTRA_PREFERRED_TONE)

        // Strategy chips — only for ETA and availability intents
        val strategyIntent = when {
            detectedIntents.contains("eta")          -> "eta"
            detectedIntents.contains("availability") -> "availability"
            else                                     -> null
        }
        val strategyOptions: List<Pair<String, String>>? = when (strategyIntent) {
            "eta"          -> listOf("eta_direct" to "Honest", "eta_delay" to "Buy time", "eta_excuse" to "Soft excuse")
            "availability" -> listOf("avail_yes" to "Open to it", "avail_maybe" to "Keep it open", "avail_no" to "Decline gently")
            else           -> null
        }
        val savedStrategy = if (convKey != null) Prefs.main(this).getString("strategy_$convKey", null) else null
        var selectedStrategy: String? = strategyOptions?.let { opts ->
            savedStrategy?.takeIf { s -> opts.any { it.first == s } } ?: opts[0].first
        }
        @Suppress("DEPRECATION")
        val openChatIntent  = intent.getParcelableExtra<PendingIntent>(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT)
        val contact         = convKey?.substringAfter(":")?.let { ProTxtBgService.stripAppPrefix(it) } ?: "Reply"
        val packageName     = convKey?.substringBefore(":") ?: ""
        val actionJson      = intent.getStringExtra(ProTxtBgService.EXTRA_ACTION_JSON)
        val isUrgent        = intent.getBooleanExtra(ProTxtBgService.EXTRA_URGENT, false)
        val contactMatchJson = intent.getStringExtra(ProTxtBgService.EXTRA_CONTACT_MATCH_JSON)
        val contactMatch = if (contactMatchJson != null) {
            try { JSONObject(contactMatchJson) } catch (_: Exception) { null }
        } else null

        // ── State ─────────────────────────────────────────────────────────────
        val isLoading = casualText == ProTxtBgService.LOADING_PLACEHOLDER
        val suggestionTs = intent.getLongExtra(ProTxtBgService.EXTRA_SUGGESTION_TS, 0L)
        val staleThresholdMs = if (detectedIntents.any { it == "eta" || it == "availability" }) 5 * 60_000L else 30 * 60_000L
        val isStale = !isLoading && suggestionTs > 0L && System.currentTimeMillis() - suggestionTs > staleThresholdMs
        // Staleness no longer auto-regenerates (see below) — the cached reply is still shown,
        // only the actual loading state hides it.
        val showSkeleton = isLoading

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

        val PURPLE    = Theme.SIGNAL
        val PURPLE_BG = Theme.SIGNAL_BG
        val TEXT      = Theme.TEXT
        val MUTED     = Theme.MUTED
        val BG        = Theme.SURFACE
        val SURFACE2  = Theme.SURFACE2
        val BORDER    = Theme.BORDER
        val GREEN     = Theme.GREEN
        val GREEN_BG  = Theme.GREEN_BG
        val CONTEXT    = Theme.CONTEXT
        val CONTEXT_BG = Theme.CONTEXT_BG

        val AVATAR_PALETTE = listOf(0xFF6366f1L, 0xFF8b5cf6L, 0xFFec4899L, 0xFFf43f5eL,
                                    0xFFf59e0bL, 0xFF10b981L, 0xFF06b6d4L, 0xFF3b82f6L)
        val avatarColor = AVATAR_PALETTE[contact.hashCode().and(0x7FFFFFFF) % AVATAR_PALETTE.size].toInt()

        // ── Error state: worker failed — there's no suggestion to edit/send, so show
        // a minimal retry prompt instead of the full reply editor below.
        if (casualText == ProTxtBgService.ERROR_PLACEHOLDER) {
            val root = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(BG)
                setPadding(dp(20), dp(24), dp(20), dp(20))
            }
            root.addView(TextView(this).apply {
                text = "Couldn't generate a reply"
                setTextColor(TEXT)
                textSize = 16f
                typeface = AppFonts.bold(this@BubbleSuggestionActivity)
            })
            root.addView(TextView(this).apply {
                text = "The request failed or timed out."
                setTextColor(MUTED)
                textSize = 13f
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.topMargin = dp(4)
                lp.bottomMargin = dp(16)
                layoutParams = lp
            })
            root.addView(TextView(this).apply {
                text = "Retry"
                setTextColor(Color.WHITE)
                textSize = 15f
                gravity = Gravity.CENTER
                typeface = AppFonts.bold(this@BubbleSuggestionActivity)
                background = GradientDrawable().apply {
                    setColor(PURPLE)
                    cornerRadius = dp(12).toFloat()
                }
                setPadding(dp(16), dp(13), dp(16), dp(13))
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(8)
                layoutParams = lp
                setOnClickListener {
                    sendAction(ProTxtBgService.ACTION_RETRY, null, null, notifId, convKey, null)
                    finish()
                }
            })
            root.addView(TextView(this).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 15f
                gravity = Gravity.CENTER
                typeface = AppFonts.medium(this@BubbleSuggestionActivity)
                setPadding(dp(16), dp(13), dp(16), dp(13))
                setOnClickListener {
                    sendAction(ProTxtBgService.ACTION_DISMISS, "", null, notifId, convKey, null)
                    finish()
                }
            })
            setContentView(root)
            return
        }

        // ── Early view declarations (referenced across closures) ───────────────
        val replyEdit = EditText(this).apply {
            setText(if (showSkeleton) "" else textMap[available[selectedIdx]])
            setTextColor(TEXT)
            setHintTextColor(MUTED)
            textSize = 15f
            typeface = AppFonts.regular(this@BubbleSuggestionActivity)
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
            typeface = AppFonts.bold(this@BubbleSuggestionActivity)
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
                val selectedTone = if (available.isNotEmpty()) available[selectedIdx] else "casual"
                val aiSuggestion = textMap[selectedTone] ?: casualText
                val text = replyEdit.text.toString().trim().ifEmpty { aiSuggestion }
                sendAction(ProTxtBgService.ACTION_SEND, text, remoteInputKey, notifId, convKey, intentExtra, aiSuggestion, selectedTone)
                if (suggestedAction != null) postActionFollowUp(suggestedAction, convKey, notifId, contactMatch)
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
        // What's actually being fetched, instead of a content-free shimmer — same wording as
        // ENRICHMENT_STATUS in intentDetector.ts. Kept in sync manually (plain display text,
        // not branching logic, so the low-risk duplication isn't worth a shared-JSON asset).
        skeletonContainer.addView(TextView(this).apply {
            text = enrichmentLoadingLabel(detectedIntents)
            setTextColor(MUTED)
            textSize = 12f
            typeface = AppFonts.regular(this@BubbleSuggestionActivity)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(8)
            }
        })
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
            })
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
                val earlierContext = if (convKey != null)
                    NotificationStore.getInstance(this@BubbleSuggestionActivity).getEarlierContext(convKey)
                else emptyList()
                val contactMemory = if (convKey != null)
                    ContactMemory.buildMemoryBlock(this@BubbleSuggestionActivity, convKey) else null
                val lastSent = if (convKey != null)
                    ContactMemory.getLastSent(this@BubbleSuggestionActivity, convKey) else null
                val regenMessage = messageExtra.ifEmpty { textMap["casual"] ?: "" }
                // Rebuild live Maps/Calendar data fresh — previously omitted entirely on
                // regen, so a refreshed suggestion had no current ETA/location to work
                // from (this is what looked like "stale" location/ETA data on refresh:
                // there was no fresh data at all, just whatever Claude could infer from
                // the bare conversation thread).
                val enrichments = ProTxtBgService.getInstance()
                    ?.buildEnrichments(regenMessage, thread, convKey, intentsRaw)
                    ?: JSONObject()
                val result = WorkerClient.call(
                    this@BubbleSuggestionActivity,
                    regenMessage,
                    thread,
                    enrichments,
                    regenerate = true,
                    earlierContext = earlierContext,
                    contactMemory = contactMemory,
                    lastSentReply = lastSent,
                    strategy = selectedStrategy,
                )
                // See ProTxtBgService.kt's runWorkerJob for why this is recorded only here,
                // after the Worker confirms the destination actually routes, rather than
                // eagerly when buildEnrichments extracts the destination text.
                if (convKey != null) {
                    result?.resolvedDestination?.let { (destinationText, label) ->
                        ContactMemory.recordDestination(this@BubbleSuggestionActivity, convKey, label, destinationText)
                    }
                }
                val rateLimited = result?.rateLimited == true
                val newCasual = result?.replies?.optString("casual")?.takeIf { it.isNotEmpty() }
                val newFormal = result?.replies?.optString("formal")?.takeIf { it.isNotEmpty() }
                val newBrief  = result?.replies?.optString("brief")?.takeIf { it.isNotEmpty() }
                runOnUiThread {
                    if (rateLimited) {
                        android.widget.Toast.makeText(
                            this@BubbleSuggestionActivity,
                            "Too many requests — try again shortly",
                            android.widget.Toast.LENGTH_SHORT
                        ).show()
                    } else if (newCasual != null) {
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
            // Every visibility toggle within root (skeleton→content, "More options"
            // expand/collapse, tone tabs appearing) gets a smooth animated transition
            // instead of an instant snap, for free, without touching each call site.
            // A slight overshoot on appearing views is the springy, physical motion
            // M3 Expressive is actually about — not just a plain fade.
            layoutTransition = LayoutTransition().apply {
                setDuration(220)
                setInterpolator(LayoutTransition.CHANGE_APPEARING, OvershootInterpolator(1.2f))
                setInterpolator(LayoutTransition.APPEARING, OvershootInterpolator(1.2f))
            }
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
                typeface = AppFonts.bold(this@BubbleSuggestionActivity)
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
                    typeface = AppFonts.bold(this@BubbleSuggestionActivity)
                })
                if (platformLabel != null) {
                    addView(TextView(this@BubbleSuggestionActivity).apply {
                        text = platformLabel
                        setTextColor(MUTED)
                        textSize = 11f
                        typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                    })
                }
            })

            // Urgency badge — computeUrgencyScore() >= 2 (ASAP language, repeated "??"/"!!",
            // a message burst, or an eta/availability intent). Purely informational, no action.
            if (isUrgent) {
                addView(TextView(this@BubbleSuggestionActivity).apply {
                    text = "Urgent"
                    setTextColor(Color.parseColor("#f97316"))
                    textSize = 11f
                    typeface = AppFonts.bold(this@BubbleSuggestionActivity)
                    background = GradientDrawable().apply {
                        setColor(Color.parseColor("#f9731622"))
                        cornerRadius = dp(8).toFloat()
                    }
                    setPadding(dp(8), dp(3), dp(8), dp(3))
                    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    lp.marginEnd = dp(8)
                    layoutParams = lp
                })
            }

            // Open-chat arrow
            if (openChatIntent != null) {
                addView(TextView(this@BubbleSuggestionActivity).apply {
                    text = "↗"
                    setTextColor(PURPLE)
                    textSize = 16f
                    typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                    setPadding(dp(8), 0, 0, 0)
                    setOnClickListener { doOpenChat() }
                })
            }
        })

        // ── Incoming message quote ────────────────────────────────────────────
        // Held so onNewJobStarted (below) can refresh the quoted text in place when a
        // later message arrives for this convKey while this same Activity instance is
        // still alive — the system never recreates it via onNewIntent, so this is the
        // only way the quote reflects anything newer than what onCreate first saw.
        var quoteText: TextView? = null
        var quoteScroll: ScrollView? = null
        val quoteInitial = messageExtra.ifEmpty { null }
        if (quoteInitial != null) {
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

                addView(ScrollView(this@BubbleSuggestionActivity).apply {
                    // Fixed height = 4 lines of 13sp text at 1.25x line spacing (~68dp).
                    // Content that overflows scrolls; fading edges show there's more.
                    layoutParams = LinearLayout.LayoutParams(0, dp(68), 1f)
                    isVerticalScrollBarEnabled = false
                    isVerticalFadingEdgeEnabled = true
                    setFadingEdgeLength(dp(16))
                    setBackgroundColor(BG)
                    quoteScroll = this
                    addView(TextView(this@BubbleSuggestionActivity).apply {
                        text = quoteInitial
                        setTextColor(MUTED)
                        textSize = 13f
                        typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                        setLineSpacing(0f, 1.25f)
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                        quoteText = this
                    })
                })
            })

            // Load the full thread, show only the last message initially so the most
            // recent context is visible at a glance. User scrolls up to see the full thread.
            if (convKey != null) {
                val tv = quoteText
                val sv = quoteScroll
                Thread {
                    val messages = NotificationStore.getInstance(this).getUnreadMessages(convKey)
                    val formatted = messages.joinToString("\n") { (sender, text) ->
                        if (sender == null) "You: $text" else "$sender: $text"
                    }
                    if (formatted.isNotEmpty() && tv != null) {
                        runOnUiThread {
                            tv.text = formatted
                            sv?.post {
                                // Measure the text at the ScrollView's actual width so the
                                // height reflects real wrapping. Fall back to screen width
                                // minus horizontal padding if layout hasn't run yet.
                                val w = sv.width.takeIf { it > 0 }
                                    ?: (resources.displayMetrics.widthPixels - dp(60))
                                tv.measure(
                                    View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.AT_MOST),
                                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
                                )
                                val lp = sv.layoutParams as LinearLayout.LayoutParams
                                lp.height = tv.measuredHeight.coerceAtMost(dp(68))
                                sv.layoutParams = lp
                                sv.fullScroll(ScrollView.FOCUS_DOWN)
                            }
                        }
                    }
                }.start()
            }
        }

        // ── Contact match banner ──────────────────────────────────────────────
        val refreshTabsFn = arrayOfNulls<((Int) -> Unit)>(1)

        if (contactMatch != null) {
            val matchName       = contactMatch.optString("displayName")
            val matchContactId  = contactMatch.optString("contactId")
            val matchTone       = contactMatch.optString("preferredTone").ifEmpty { null }
            val matchConfidence = contactMatch.optDouble("confidence", 0.0)
            val isCrossApp      = contactMatch.optBoolean("crossApp", false)
            val crossAppSrc     = contactMatch.optString("crossAppSourceLabel").ifEmpty { null }
            val currentAppLabel = ProTxtBgService.appLabel(packageName)

            val isHighConf = matchConfidence >= 0.88
            // Cross-app uses the context accent (teal); same-app uses amber scaled by confidence
            val accentColor = if (isCrossApp) Theme.CONTEXT
                              else Color.parseColor(if (isHighConf) "#f59e0b" else "#d97706")
            val accentBg    = if (isCrossApp) Color.parseColor("#2f8f8a18")
                              else Color.parseColor(if (isHighConf) "#f59e0b18" else "#d9770610")
            val accentBorder = if (isCrossApp) Color.parseColor("#2f8f8a44")
                               else Color.parseColor(if (isHighConf) "#f59e0b44" else "#d9770630")

            val bannerText = when {
                isCrossApp  -> "Same person as $matchName?"
                isHighConf  -> "Is this $matchName?"
                else        -> "Possibly $matchName?"
            }

            val banner = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = GradientDrawable().apply {
                    setColor(accentBg)
                    cornerRadius = dp(8).toFloat()
                    setStroke(1, accentBorder)
                }
                setPadding(dp(10), dp(7), dp(10), dp(7))
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }

            // Header row
            val headerRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            banner.addView(headerRow)

            headerRow.addView(TextView(this).apply {
                text = bannerText
                setTextColor(accentColor)
                textSize = 12f
                typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
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

            if (isCrossApp && crossAppSrc != null) {
                // Sub-label explaining the existing link
                banner.addView(TextView(this).apply {
                    text = "Already linked via $crossAppSrc · $currentAppLabel"
                    setTextColor(MUTED)
                    textSize = 11f
                    typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    lp.topMargin = dp(2); lp.bottomMargin = dp(6)
                    layoutParams = lp
                })
                // Action row for cross-app
                val actionRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.END
                }
                banner.addView(actionRow)
                actionRow.addView(TextView(this).apply {
                    text = "Keep separate"
                    setTextColor(MUTED)
                    textSize = 12f
                    typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                    setPadding(0, dp(4), dp(14), dp(4))
                    setOnClickListener {
                        val prefs = Prefs.main(this@BubbleSuggestionActivity)
                        val conf = try { JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
                        val sepId = "sep:${contact.lowercase().replace(Regex("[^a-z0-9]"), "_").take(36)}_${packageName.substringAfterLast(".").take(16)}"
                        if (convKey != null) conf.put(convKey, sepId)
                        prefs.edit().putString("confirmed_identities", conf.toString()).apply()
                        banner.visibility = View.GONE
                    }
                })
                actionRow.addView(TextView(this).apply {
                    text = "Yes, link"
                    setTextColor(accentColor)
                    textSize = 12f
                    typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
                    setPadding(0, dp(4), 0, dp(4))
                    setOnClickListener { confirmMatch() }
                })
            } else {
                headerRow.addView(TextView(this).apply {
                    text = "Yes"
                    setTextColor(accentColor)
                    textSize = 12f
                    typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
                    setPadding(dp(12), dp(4), dp(6), dp(4))
                    setOnClickListener { confirmMatch() }
                })

            // Parse alternative candidates for the "No" disambiguation expansion (same-app only)

            val candidatesArr = try {
                contactMatch.optJSONArray("candidates") ?: JSONArray()
            } catch (_: Exception) { JSONArray() }
            val alternatives = (0 until candidatesArr.length())
                .mapNotNull { candidatesArr.optJSONObject(it) }
                .filter { it.optString("contactId") != matchContactId }

            banner.addView(TextView(this).apply {
                text = "No"
                setTextColor(MUTED)
                textSize = 12f
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                setPadding(dp(6), dp(4), 0, dp(4))
                setOnClickListener {
                    if (alternatives.isEmpty()) {
                        banner.visibility = View.GONE
                        return@setOnClickListener
                    }
                    // Replace banner contents with the disambiguation picker in-place
                    banner.removeAllViews()
                    banner.orientation = LinearLayout.VERTICAL
                    banner.addView(TextView(this@BubbleSuggestionActivity).apply {
                        text = "Who is this?"
                        setTextColor(accentColor)
                        textSize = 12f
                        typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
                        setPadding(0, 0, 0, dp(6))
                    })
                    for (candidate in alternatives) {
                        val cId   = candidate.optString("contactId")
                        val cName = candidate.optString("displayName")
                        val cTone = candidate.optString("preferredTone").ifEmpty { null }
                        banner.addView(TextView(this@BubbleSuggestionActivity).apply {
                            text = cName
                            setTextColor(accentColor)
                            textSize = 12f
                            typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                            setPadding(0, dp(3), 0, dp(3))
                            setOnClickListener {
                                val prefs = Prefs.main(this@BubbleSuggestionActivity)
                                val conf = try {
                                    JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
                                } catch (_: Exception) { JSONObject() }
                                if (convKey != null) conf.put(convKey, cId)
                                prefs.edit().putString("confirmed_identities", conf.toString()).apply()
                                if (cTone != null && !isLoading) {
                                    val toneIdx = available.indexOf(cTone)
                                    if (toneIdx >= 0) {
                                        selectedIdx = toneIdx
                                        replyEdit.setText(textMap[available[toneIdx]])
                                        replyEdit.setSelection(replyEdit.text.length)
                                        refreshTabsFn[0]?.invoke(toneIdx)
                                    }
                                }
                                banner.visibility = View.GONE
                            }
                        })
                    }
                    banner.addView(TextView(this@BubbleSuggestionActivity).apply {
                        text = "+ Save to contacts"
                        setTextColor(MUTED)
                        textSize = 12f
                        typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                        setPadding(0, dp(6), 0, 0)
                        setOnClickListener {
                            startActivity(Intent(ContactsContract.Intents.Insert.ACTION).apply {
                                putExtra(ContactsContract.Intents.Insert.NAME, contact)
                            })
                            banner.visibility = View.GONE
                        }
                    })
                }
            })
            } // end same-app else block
            root.addView(banner)
        }

        val isPro = Prefs.main(this).getBoolean("is_pro", false)

        // ── View sections, assembled in final display order near the end of
        // onCreate (see "Assemble sections" below) rather than mounted inline
        // as each is built — lets tone tabs sit directly above the reply text,
        // and strategy/intent chips collapse behind "More options", without
        // restructuring any of the construction logic itself.
        var strategySectionView: View? = null
        var toneSectionView: View? = null
        var addActionBarView: View? = null
        var addActionRowView: View? = null

        // ── Strategy chips ────────────────────────────────────────────────────
        // Only shown for ETA and availability intents. First chip is pre-selected
        // (from Prefs or default). Tapping a chip updates selectedStrategy and
        // triggers a regen if a reply is already showing. Pro only.
        if (strategyOptions != null && selectedStrategy != null && isPro) {
            val strategyChipViews = mutableListOf<TextView>()

            fun refreshStrategyChips(selected: String) {
                strategyChipViews.forEach { chip ->
                    val isActive = chip.tag as? String == selected
                    chip.background = GradientDrawable().apply {
                        setColor(if (isActive) PURPLE_BG else Color.TRANSPARENT)
                        cornerRadius = dp(12).toFloat()
                        setStroke(1, if (isActive) PURPLE else BORDER)
                    }
                    chip.setTextColor(if (isActive) PURPLE else MUTED)
                    chip.typeface = if (isActive) AppFonts.semibold(this) else AppFonts.regular(this)
                }
            }

            val strategyRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }

            strategyOptions.forEachIndexed { idx, (key, label) ->
                val chip = TextView(this).apply {
                    text = label
                    tag = key
                    textSize = 12f
                    gravity = Gravity.CENTER
                    setPadding(dp(10), dp(6), dp(10), dp(6))
                    val lp2 = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    if (idx < strategyOptions.size - 1) lp2.marginEnd = dp(6)
                    layoutParams = lp2
                    setOnClickListener {
                        selectedStrategy = key
                        if (convKey != null) {
                            Prefs.main(this@BubbleSuggestionActivity).edit()
                                .putString("strategy_$convKey", key).apply()
                        }
                        refreshStrategyChips(key)
                        // Only regen if a reply is already loaded — if loading, the
                        // user's pick will be applied on the next manual regen.
                        if (skeletonContainer.visibility != View.VISIBLE) {
                            triggerRegen()
                        }
                    }
                }
                strategyChipViews.add(chip)
                strategyRow.addView(chip)
            }

            refreshStrategyChips(selectedStrategy!!)
            strategySectionView = strategyRow
        } else if (strategyOptions != null && !isPro) {
            val lockRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(10)
                layoutParams = lp
            }
            lockRow.addView(TextView(this).apply {
                text = "🔒 Reply strategy — Pro"
                textSize = 11f
                setTextColor(MUTED)
                setPadding(dp(10), dp(5), dp(10), dp(5))
                background = GradientDrawable().apply {
                    setColor(Color.TRANSPARENT)
                    cornerRadius = dp(12).toFloat()
                    setStroke(1, BORDER)
                }
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            })
            strategySectionView = lockRow
        }

        // ── Reply area: edit text (ready) or skeleton (loading) — mounted
        // later, directly below the tone pills (see "Assemble sections").

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
                // Animate the text color transition instead of an instant hard recolor —
                // the background swap (fill/stroke) reads fine as an instant change since
                // it's a shape+border, but a snapped text color is the part that looked
                // like a plain "just recolor" toggle.
                val fromColor = v.currentTextColor
                val toColor = if (active) PURPLE else MUTED
                if (fromColor != toColor) {
                    ValueAnimator.ofObject(ArgbEvaluator(), fromColor, toColor).apply {
                        duration = 160
                        addUpdateListener { v.setTextColor(it.animatedValue as Int) }
                        start()
                    }
                }
                v.typeface = if (active) AppFonts.semibold(this) else AppFonts.regular(this)
            }
        }
        refreshTabsFn[0] = ::refreshTabs

        if (!showSkeleton && available.size > 1 && isPro) {
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
                    Analytics.log(this@BubbleSuggestionActivity, "tone_selected", mapOf("tone" to tone, "source" to "bubble"))
                }
                tabViews[tone] = tab
                tabRow.addView(tab)
            }
            refreshTabs(selectedIdx)
            toneSectionView = tabRow
        } else if (!showSkeleton && available.size > 1 && !isPro) {
            // Show a locked Pro hint where tone pills would appear
            val lockRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = dp(14)
                layoutParams = lp
            }
            val lockChip = TextView(this).apply {
                text = "🔒 Tone learning — Pro"
                textSize = 11f
                setTextColor(MUTED)
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                setPadding(dp(10), dp(5), dp(10), dp(5))
                background = GradientDrawable().apply {
                    setColor(Color.TRANSPARENT)
                    cornerRadius = dp(12).toFloat()
                    setStroke(1, BORDER)
                }
                val lp2 = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                layoutParams = lp2
            }
            lockRow.addView(lockChip)
            toneSectionView = lockRow
        }

        // ── Intent context bar ────────────────────────────────────────────────
        val intentLabels = mapOf("eta" to "ETA", "availability" to "Calendar", "incoming_location" to "📍 Location")
        val allKnownIntents = listOf("eta", "availability", "incoming_location")
        val activeIntents = detectedIntents.filter { it != "other" }
        val unusedIntents = allKnownIntents.filter { it !in detectedIntents }

        // active=true chips are detected context signals (ETA/Calendar/Location) — the
        // teal accent is exactly what it's for. active=false ("+ ETA"/"+ Calendar" etc.,
        // discoverable add-this chips) stays green — a distinct "you can add this"
        // affordance, not a signal that's already present.
        fun makeChip(label: String, active: Boolean = true): TextView = TextView(this).apply {
            text = label
            setTextColor(if (active) CONTEXT else GREEN)
            textSize = 11f
            typeface = AppFonts.medium(this@BubbleSuggestionActivity)
            setPadding(dp(8), dp(3), dp(8), dp(3))
            background = GradientDrawable().apply {
                setColor(if (active) CONTEXT_BG else GREEN_BG)
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
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
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

        // intentBar/addContextRow mounted later, inside the "More options"
        // collapsible section (see "Assemble sections").

        // ── Action area ───────────────────────────────────────────────────────
        // actionContainer mounted later (see "Assemble sections") — stays
        // directly on root, always visible when populated, since a real
        // suggested action (add to calendar, etc.) is a primary CTA, not
        // secondary clutter.

        fun showActionCTA(action: JSONObject) {
            val actionType  = action.optString("type")
            val actionLabel = action.optString("label").ifEmpty { null } ?: return
            actionContainer.removeAllViews()
            actionContainer.addView(TextView(this@BubbleSuggestionActivity).apply {
                text = actionLabel
                setTextColor(GREEN)
                textSize = 13f
                typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
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
                                    ActionDateTime.parse(datetimeStr)?.let { dt ->
                                        val startMs = dt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                                        putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
                                        putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMs + duration * 60_000L)
                                    }
                                }
                            }
                            // Clear from homescreen pending list now that it's been acted on
                            convKey?.let { key ->
                                val id = key.hashCode().and(0x7FFFFFFF).toString()
                                ProTxtBgService.getInstance()?.clearPendingCalendarAction(id)
                            }
                            try { startActivity(calIntent) } catch (_: Exception) {}
                        }
                        "maps_open" -> {
                            val address = action.optString("address").ifEmpty { null } ?: return@setOnClickListener
                            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(address)}"))) } catch (_: Exception) {}
                        }
                        "follow_up" -> {
                            val task    = action.optString("task").ifEmpty { actionLabel }
                            val dueHint = action.optString("dueHint").ifEmpty { null }
                            val id      = convKey?.hashCode()?.and(0x7FFFFFFF)?.toString()
                            if (id != null) {
                                val contact = contactMatch?.optString("displayName")?.ifEmpty { null } ?: ""
                                ProTxtBgService.getInstance()?.confirmFollowUp(id, task, contact, dueHint)
                            }
                            text = "✓ Added to follow-ups"
                            setTextColor(GREEN)
                            isClickable = false
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
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
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
            addActionBarView = addActionBar
            addActionRowView = addActionRow
        }

        // ── Assemble sections in final display order ───────────────────────────
        // Tone tabs sit directly above the reply text they control. Strategy
        // chips and intent-context chips are secondary — not needed for the
        // common "accept the suggestion and send" path — so they collapse
        // behind a "More options" toggle instead of pushing Send out of view.
        // Send itself is no longer mounted here at all: it's a fixed footer
        // outside the ScrollView (see setContentView below), always visible
        // regardless of how much optional content above it is expanded.
        toneSectionView?.let { root.addView(it) }
        root.addView(replyEdit)
        root.addView(skeletonContainer)

        // ── Tier 2 (behind "•••"): style-match attribution, strategy/intent
        // chips, and mark-as-read/dismiss — none of this is needed for the
        // common "accept the suggestion and send" path, so it collapses out
        // of the way instead of pushing Send out of view. Regenerate stays
        // visible below — used often enough to earn a permanent spot.
        val moreOptionsContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        val hiddenLabels = mutableListOf<String>()

        // Style-match attribution — only shown once there's a real signal behind it
        // (StyleProfileBuilder's own ≥3-edit / ≥2-per-contact thresholds), no fake
        // "learning..." state pre-signal.
        if (!showSkeleton) {
            val signal = StyleProfileBuilder.signalFor(this, contact)
            val attributionText = when {
                signal.contactSpecific -> "Matches your tone with ${contact.take(28)}"
                signal.hasProfile      -> "Matches your tone"
                else                   -> null
            }
            if (attributionText != null) {
                moreOptionsContainer.addView(TextView(this).apply {
                    text = attributionText
                    setTextColor(PURPLE)
                    textSize = 11.5f
                    typeface = AppFonts.medium(this@BubbleSuggestionActivity)
                    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    lp.bottomMargin = dp(10)
                    layoutParams = lp
                })
                hiddenLabels.add("tone match")
            }
        }

        strategySectionView?.let { moreOptionsContainer.addView(it) }
        moreOptionsContainer.addView(intentBar)
        if (unusedIntents.isNotEmpty()) moreOptionsContainer.addView(addContextRow)
        if (strategySectionView != null || activeIntents.isNotEmpty() || unusedIntents.isNotEmpty()) {
            hiddenLabels.add("context")
        }

        moreOptionsContainer.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(2)
            layoutParams = lp

            addView(TextView(this@BubbleSuggestionActivity).apply {
                text = "Mark as read"
                setTextColor(MUTED)
                textSize = 13f
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                setPadding(0, 0, dp(14), 0)
                setOnClickListener {
                    sendBroadcast(Intent(this@BubbleSuggestionActivity, ReplySendReceiver::class.java).apply {
                        action = ProTxtBgService.ACTION_MARK_READ
                        putExtra(ProTxtBgService.EXTRA_NOTIF_ID, notifId)
                        if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
                    })
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
                typeface = AppFonts.regular(this@BubbleSuggestionActivity)
                setOnClickListener {
                    val dismissText = textMap["casual"]?.takeIf { it.isNotEmpty() } ?: ""
                    sendAction(ProTxtBgService.ACTION_DISMISS, dismissText, null, notifId, convKey, null)
                    finish()
                }
            })
        })
        hiddenLabels.add("mark as read")

        val collapsedLabel = "••• ${hiddenLabels.size} more — ${hiddenLabels.joinToString(", ")}"
        val moreExpanded = booleanArrayOf(false)
        val moreToggle = TextView(this).apply {
            text = collapsedLabel
            setTextColor(MUTED)
            textSize = 11.5f
            typeface = AppFonts.mono(this@BubbleSuggestionActivity)
            setPadding(0, dp(4), 0, dp(4))
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(8)
            layoutParams = lp
            setOnClickListener {
                moreExpanded[0] = !moreExpanded[0]
                moreOptionsContainer.visibility = if (moreExpanded[0]) View.VISIBLE else View.GONE
                text = if (moreExpanded[0]) "▴ Less" else collapsedLabel
            }
        }
        root.addView(moreToggle)
        root.addView(moreOptionsContainer)

        root.addView(actionContainer)
        addActionBarView?.let { root.addView(it) }
        addActionRowView?.let { root.addView(it) }

        // ── Tier 1: regenerate — stays visible below the collapsible section ────
        regenBtn = TextView(this).apply {
            // Stale suggestions still show as-is (may be outdated) — flag the button rather
            // than silently re-billing a Claude call, and let the user opt in to a refresh.
            text = if (isStale) "↺ Refresh" else "↺"
            setTextColor(if (isStale) PURPLE else MUTED)
            textSize = 16f
            typeface = AppFonts.semibold(this@BubbleSuggestionActivity)
            isEnabled = !showSkeleton
            setOnClickListener {
                Analytics.log(this@BubbleSuggestionActivity, "suggestion_regenerated", mapOf("source" to "bubble"))
                triggerRegen()
            }
        }
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
            addView(regenBtn)
        })

        // ── onReplyReady: invoked by BgService when worker finishes ───────────
        // Stays registered for the Activity's whole lifetime (removed only in onDestroy)
        // — this same instance can receive results for several messages in a row if the
        // user leaves the bubble open without sending/dismissing, since the system never
        // recreates it to deliver a fresh Intent.
        if (convKey != null) onReplyReady[convKey] = { casual, formal, brief, action ->
            runOnUiThread {
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
                if (action != null) {
                    showActionCTA(action)
                } else {
                    actionContainer.visibility = View.GONE
                    actionContainer.removeAllViews()
                }
            }
        }

        // ── onNewJobStarted: a later message for this convKey started a new worker
        // call while this Activity is still open — flip back to the loading skeleton
        // and show the new message so the bubble doesn't look stuck on stale content.
        if (convKey != null) onNewJobStarted[convKey] = { latestMessage ->
            runOnUiThread {
                quoteText?.text = latestMessage
                restartSkeletonAnimations()
                skeletonContainer.visibility = View.VISIBLE
                replyEdit.visibility = View.GONE
                replyEdit.isEnabled = false
                sendBtn.isEnabled = false
                sendBtn.setTextColor(MUTED)
                (sendBtn.background as? GradientDrawable)?.setColor(SURFACE2)
                regenBtn?.isEnabled = false
                actionContainer.visibility = View.GONE
                actionContainer.removeAllViews()
            }
        }

        // Previously auto-called triggerRegen() here on staleness, silently re-billing a
        // Claude call every time a stale bubble was opened. Now just flags the existing
        // regenerate button (below) so the user decides whether a refresh is worth it.

        // Send lives in a fixed footer below the ScrollView, not inside it —
        // always reachable without scrolling regardless of how much optional
        // content above it is expanded. Only the ScrollView (weight 1) grows
        // to fill remaining space; the footer is a fixed height.
        val scrollView = ScrollView(this).apply {
            setBackgroundColor(BG)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            addView(root.also {
                it.layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
            })
        }
        val sendFooter = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(18), 0, dp(18), dp(14))
            addView(sendBtn)
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
            addView(scrollView)
            addView(sendFooter)
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        myConvKey?.let {
            onReplyReady.remove(it)
            onNewJobStarted.remove(it)
        }
    }

    private fun postActionFollowUp(action: JSONObject, convKey: String?, notifId: Int, contactMatch: JSONObject? = null) {
        val actionType  = action.optString("type")
        val actionLabel = action.optString("label").ifEmpty { null } ?: return

        var bodyText = ""
        val actionIntent = when (actionType) {
            "calendar_add" -> {
                val title       = action.optString("title").ifEmpty { "Event" }
                val datetimeStr = action.optString("datetime").ifEmpty { null }
                val duration    = action.optInt("durationMinutes", 60)
                val contactName = contactMatch?.optString("displayName")?.ifEmpty { null }
                val contactId   = contactMatch?.optString("contactId")?.ifEmpty { null }
                val contactEmail = contactId?.let { lookupContactEmail(it) }
                bodyText = buildCalendarBody(title, datetimeStr, duration)
                Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    if (contactName != null) {
                        putExtra(CalendarContract.Events.DESCRIPTION, "with $contactName")
                    }
                    if (contactEmail != null) {
                        putExtra(Intent.EXTRA_EMAIL, arrayOf(contactEmail))
                    }
                    if (datetimeStr != null) {
                        ActionDateTime.parse(datetimeStr)?.let { dt ->
                            val startMs = dt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMs + duration * 60_000L)
                        }
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

    private fun lookupContactEmail(contactId: String): String? {
        return try {
            contentResolver.query(
                ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
                "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
                arrayOf(contactId),
                "${ContactsContract.CommonDataKinds.Email.IS_PRIMARY} DESC"
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0).ifEmpty { null } else null
            }
        } catch (_: Exception) { null }
    }

    // Mirrors ENRICHMENT_STATUS in src/utils/intentDetector.ts — what's being fetched for
    // the detected intent(s), shown instead of a content-free loading shimmer.
    private fun enrichmentLoadingLabel(intents: List<String>): String {
        val parts = mutableListOf<String>()
        if (intents.contains("eta")) parts.add("journey time")
        if (intents.contains("availability") || intents.contains("general")) parts.add("your calendar")
        if (intents.contains("booking")) parts.add("your bookings")
        if (intents.contains("incoming_location")) parts.add("their location")
        return if (parts.isEmpty()) "Thinking…" else "Checking ${parts.joinToString(" and ")}…"
    }

    private fun buildCalendarBody(title: String, datetimeStr: String?, durationMinutes: Int): String {
        if (datetimeStr == null) return title
        val dt = ActionDateTime.parse(datetimeStr) ?: return title
        return run {
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
        originalSuggestion: String? = null, toneSelected: String? = null,
    ) {
        sendBroadcast(Intent(this, ReplySendReceiver::class.java).apply {
            this.action = action
            if (replyText != null) putExtra(ProTxtBgService.EXTRA_REPLY_TEXT, replyText)
            if (remoteInputKey != null) putExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(ProTxtBgService.EXTRA_NOTIF_ID, notifId)
            putExtra(ProTxtBgService.EXTRA_SKIP_CANCEL, true)
            if (convKey != null) putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
            if (intentExtra != null) putExtra(ProTxtBgService.EXTRA_INTENT, intentExtra)
            if (originalSuggestion != null) putExtra(ProTxtBgService.EXTRA_ORIGINAL_SUGGESTION, originalSuggestion)
            if (toneSelected != null) putExtra(ProTxtBgService.EXTRA_TONE_SELECTED, toneSelected)
        })
        // Defer the cancel to the next Looper tick so finish() is always called first.
        // Cancelling the notification while the bubble is still expanded sends it to the
        // inactive overflow; deferring gives Android time to mark the activity as finishing.
        if (notifId != -1) {
            val nm = getSystemService(NotificationManager::class.java)
            Handler(Looper.getMainLooper()).post { nm.cancel(notifId) }
        }
    }
}
