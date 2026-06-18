package com.contextreply.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.MaterialColors

class ProTxtAccessibilityService : AccessibilityService() {

    companion object {
        private const val PREFS_NAME = "contextreply_prefs"
        private const val MAX_AGE_MS = 5 * 60 * 1000L

        // Set to the foreground messaging package while user is in the app.
        // Read by ProTxtBgService to skip the bubble and route to the overlay instead.
        @Volatile var activePackage: String? = null

        // Invoked by ProTxtBgService (on the worker thread) when a suggestion is ready.
        // The accessibility service registers this in onServiceConnected and clears it on destroy.
        @Volatile var onSuggestionReady: ((pkg: String) -> Unit)? = null
    }

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var overlayParams: WindowManager.LayoutParams? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Tone state for the currently shown overlay
    private var tones = mapOf<String, String>()   // key → text
    private var selectedTone = "casual"
    private var currentContact = ""

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        onSuggestionReady = { pkg ->
            if (activePackage == pkg) mainHandler.post {
                if (isInCorrectConversation(pkg)) maybeShowOverlay(pkg)
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // TYPE_WINDOWS_CHANGED fires with a null packageName (it's a global window-list event),
        // so it must be handled before the pkg-null guard below.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            val apkg = activePackage
            if (apkg != null) {
                // Already tracking a messaging app — check if still on screen
                val targetVisible = windows?.any { w ->
                    val root = w.root
                    val match = w.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                            root?.packageName?.toString() == apkg
                    @Suppress("DEPRECATION") root?.recycle()
                    match
                } == true
                if (!targetVisible) {
                    activePackage = null
                    dismissOverlay()
                    // Messaging app left the screen — bring any pending ConTxt bubble back
                    // into view so the user sees it in the bubble column without unlocking.
                    if (ProTxtBgService.pendingBubbles.isNotEmpty())
                        mainHandler.postDelayed({
                            ProTxtBgService.getInstance()?.repostPendingBubbles()
                        }, 400L)
                } else if (overlayView != null) {
                    updateOverlayPosition()
                }
            } else {
                // Not currently tracking — dismiss any stale overlay then check if the user
                // just gesture-switched back to a messaging app conversation.
                if (overlayView != null) { dismissOverlay(); return }
                val returnedPkg = ProTxtBgService.TARGET_PACKAGES.firstOrNull { pkg ->
                    windows?.any { w ->
                        val root = w.root
                        val match = w.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                                root?.packageName?.toString() == pkg
                        @Suppress("DEPRECATION") root?.recycle()
                        match
                    } == true
                } ?: return
                scheduleReshow(returnedPkg)
            }
            return
        }

        val pkg = event.packageName?.toString() ?: return

        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                if (pkg !in ProTxtBgService.TARGET_PACKAGES) return
                // Detect when the user presses the send button inside the messaging app.
                // This is the most real-time signal that the user replied via the original
                // app rather than via ConTxt. We dismiss our bubble immediately on this event
                // rather than waiting for onNotificationPosted Gate 6.
                //
                // Stable send-button resource IDs (confirmed across WhatsApp versions):
                //   WhatsApp / WhatsApp Business: com.whatsapp:id/send
                //   Telegram: Telegram sends on IME action (no dedicated send button), so
                //     we cannot detect it this way — Gate 6 handles Telegram instead.
                val source = event.source ?: return
                val viewId = source.viewIdResourceName
                @Suppress("DEPRECATION") source.recycle()
                val sendButtonId = when (pkg) {
                    "com.whatsapp"    -> "com.whatsapp:id/send"
                    "com.whatsapp.w4b" -> "com.whatsapp.w4b:id/send"
                    else -> null
                }
                if (viewId != null && viewId == sendButtonId) {
                    if (BuildConfig.DEBUG) android.util.Log.d("ProTxt",
                        "send button clicked in $pkg — dismissing bubble")
                    val prefs = Prefs.main(this)
                    val convKey = prefs.getString("last_suggestion_conv_$pkg", null)
                    if (convKey != null) {
                        val notifId = convKey.hashCode().and(0x7FFFFFFF)
                        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
                        ProTxtBgService.getInstance()?.let { svc ->
                            svc.activeBubbles.remove(convKey)
                            svc.arrivalBuffer.remove(convKey)
                            ProTxtBgService.pendingBubbles.remove(convKey)
                        }
                        NotificationStore.getInstance(this).markReplied(convKey)
                        // Try to capture what was in the input field as the sent text.
                        // WhatsApp may clear the field before this event fires, but attempt
                        // it opportunistically — ContactMemory.saveLastSent is a no-op on blank.
                        captureInputFieldText(pkg, convKey)
                    }
                }
            }
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (pkg !in ProTxtBgService.TARGET_PACKAGES) return
                if (overlayView == null) {
                    scheduleReshow(pkg)
                }
                // Don't dismiss on window state changes within the app — the accessibility
                // text search is flaky (WhatsApp fires events during typing indicators etc.)
                // and causes the overlay to flash. TYPE_WINDOWS_CHANGED handles app-exit dismissal.
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> {
                val node = event.source ?: return
                val editable = node.isEditable
                @Suppress("DEPRECATION") node.recycle()
                if (pkg !in ProTxtBgService.TARGET_PACKAGES || !editable) return
                activePackage = pkg

                // Auto-inject suggestion when user tapped "open chat" from the bubble
                val prefs = Prefs.main(this)
                val pendingText = prefs.getString("pending_inject_$pkg", null)
                if (pendingText != null) {
                    prefs.edit().remove("pending_inject_$pkg").apply()
                    injectText(pendingText)
                    clearAndDismiss(pkg)
                    return
                }

                if (overlayView == null && isInCorrectConversation(pkg)) {
                    maybeShowOverlay(pkg)
                }
            }
        }
    }

    // Returns true if the user is currently in the conversation that triggered the pending
    // suggestion. Uses findAccessibilityNodeInfosByText (system API, case-insensitive) rather
    // than manual tree traversal — more reliable across apps and device skins.
    // Returns false (don't show/keep overlay) when we can positively confirm a mismatch.
    // Returns false if windows / root unavailable — scheduleReshow retries handle timing.
    // Stable resource IDs for the conversation title node in each messaging app.
    // These nodes only exist inside an open conversation — not on the chat list — so a hit
    // means we are definitely in a conversation view (no false positives from list entries).
    private val CONVERSATION_TITLE_VIEW_ID = mapOf(
        "com.whatsapp"                   to "com.whatsapp:id/conversation_contact_name",
        "com.whatsapp.w4b"               to "com.whatsapp.w4b:id/conversation_contact_name",
        "org.telegram.messenger"         to "org.telegram.messenger:id/name_text",
        "org.telegram.messenger.web"     to "org.telegram.messenger.web:id/name_text",
    )

    // Returns true when the user is inside the specific conversation that has the pending
    // suggestion. Uses a stable per-app view-ID lookup rather than text search — the view ID
    // only exists inside a conversation screen, eliminating false positives from the chat list,
    // and is populated before the full accessibility tree is ready (no rebuild flakiness).
    // Falls back to a top-bar text search for apps without a known view ID.
    private fun isInCorrectConversation(packageName: String): Boolean {
        val prefs = Prefs.main(this)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return false
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        if (age > MAX_AGE_MS) return false

        val contactRaw = convKey.substringAfter(":").trim()
        if (contactRaw.startsWith("group:") || contactRaw.startsWith("id:")) return true
        val contact = ProTxtBgService.stripAppPrefix(contactRaw).trim().lowercase()
        if (contact.isEmpty()) return true

        val root = rootInActiveWindow ?: return false
        if (root.packageName?.toString() != packageName) {
            @Suppress("DEPRECATION") root.recycle()
            return false
        }

        val viewId = CONVERSATION_TITLE_VIEW_ID[packageName]
        if (viewId != null) {
            val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
            if (nodes.isEmpty()) {
                @Suppress("DEPRECATION") root.recycle()
                return false  // Node absent → not inside a conversation view
            }
            val screenName = nodes[0].text?.toString()?.trim()?.lowercase() ?: ""
            nodes.forEach { @Suppress("DEPRECATION") it.recycle() }
            @Suppress("DEPRECATION") root.recycle()
            return screenName.contains(contact) || contact.contains(screenName)
        }

        // Fallback for apps without a known stable view ID: restrict text search to the
        // top 30% of the screen (action bar only) to avoid chat-list false positives.
        val topCutoff = (resources.displayMetrics.heightPixels * 0.30).toInt()
        val found = findTextInTopBar(root, contact, topCutoff)
        @Suppress("DEPRECATION") root.recycle()
        return found
    }

    private fun findTextInTopBar(node: AccessibilityNodeInfo, target: String, topCutoff: Int): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.top > topCutoff) return false  // Entire node is below the action bar
        val text = node.text?.toString()?.lowercase() ?: ""
        val desc = node.contentDescription?.toString()?.lowercase() ?: ""
        if (text.contains(target) || desc.contains(target)) return true
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findTextInTopBar(child, target, topCutoff)
            @Suppress("DEPRECATION") child.recycle()
            if (found) return true
        }
        return false
    }

    private var pendingAction: org.json.JSONObject? = null

    private fun maybeShowOverlay(packageName: String) {
        val prefs = Prefs.main(this)
        val casual = prefs.getString("last_suggestion_$packageName", null)?.takeIf { it.isNotEmpty() }
            ?: return
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        if (age > MAX_AGE_MS) return

        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: ""
        currentContact = convKey.substringAfter(":").let { key ->
            when {
                key.startsWith("group:") -> "Group chat"
                key.startsWith("id:") -> ""
                else -> ProTxtBgService.stripAppPrefix(key).take(40)
            }
        }

        val formal = prefs.getString("last_suggestion_formal_$packageName", null)?.takeIf { it.isNotEmpty() }
        val brief  = prefs.getString("last_suggestion_brief_$packageName", null)?.takeIf { it.isNotEmpty() }
        val actionJson = prefs.getString("last_suggestion_action_$packageName", null)?.takeIf { it.isNotEmpty() }
        pendingAction = actionJson?.let { try { org.json.JSONObject(it) } catch (_: Exception) { null } }

        tones = buildMap {
            put("casual", casual)
            if (formal != null) put("formal", formal)
            if (brief  != null) put("brief", brief)
        }
        selectedTone = if (tones.containsKey("casual")) "casual" else tones.keys.first()
        showOverlay(packageName)
    }

    // Schedules an attempt to show the overlay for `pkg`. Uses `isInCorrectConversation` as
    // the sole gate — deliberately does NOT guard on `activePackage` because intermediate
    // TYPE_WINDOWS_CHANGED events during a gesture transition can clear it before the callback fires.
    // Retries with increasing delays — the accessibility tree may not be populated immediately.
    private fun scheduleReshow(pkg: String, attempt: Int = 0) {
        activePackage = pkg
        val delay = when (attempt) { 0 -> 300L; 1 -> 500L; 2 -> 700L; else -> 1000L }
        mainHandler.postDelayed({
            if (overlayView != null) return@postDelayed
            if (isInCorrectConversation(pkg)) {
                activePackage = pkg
                maybeShowOverlay(pkg)
            } else if (attempt < 3) {
                scheduleReshow(pkg, attempt + 1)
            }
        }, delay)
    }

    private data class OverlayColors(
        val bg: Int, val text: Int, val muted: Int, val accent: Int, val accentBg: Int
    )

    private fun resolveColors(): OverlayColors {
        val isNight = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        val baseTheme = if (isNight)
            com.google.android.material.R.style.Theme_Material3_Dark_NoActionBar
        else
            com.google.android.material.R.style.Theme_Material3_Light_NoActionBar
        // DynamicColors.wrapContextIfAvailable applies wallpaper-derived colors on API 31+;
        // on older versions it returns the context unchanged (Material3 defaults apply).
        val ctx = DynamicColors.wrapContextIfAvailable(ContextThemeWrapper(this, baseTheme))
        fun attr(a: Int) = MaterialColors.getColor(ctx, a, 0)
        val accent = attr(com.google.android.material.R.attr.colorPrimary)
        return OverlayColors(
            bg       = attr(com.google.android.material.R.attr.colorSurface),
            text     = attr(com.google.android.material.R.attr.colorOnSurface),
            muted    = attr(com.google.android.material.R.attr.colorOnSurfaceVariant),
            accent   = accent,
            accentBg = Color.argb(0x22, Color.red(accent), Color.green(accent), Color.blue(accent))
        )
    }

    private fun showOverlay(packageName: String) {
        dismissOverlay()
        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val (BG, TEXT, MUTED, PURPLE, PURPLE_BG) = resolveColors()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            elevation = dp(6).toFloat()
            setPadding(dp(16), dp(10), dp(16), dp(10))
        }

        // Contact name header — shows who the suggestion is for, important when
        // the user is in a different conversation than the one that triggered the suggestion.
        if (currentContact.isNotEmpty()) {
            root.addView(TextView(this).apply {
                text = "↩ $currentContact"
                setTextColor(MUTED)
                textSize = 11f
                setPadding(0, 0, 0, dp(4))
            })
        }

        // Reply text
        val replyView = TextView(this).apply {
            text = tones[selectedTone]
            setTextColor(TEXT)
            textSize = 14f
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        }
        root.addView(replyView)

        // Tone tabs + actions row
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)

            // Tone tabs (left side)
            val toneOrder = listOf("casual", "formal", "brief")
            val available = toneOrder.filter { tones.containsKey(it) }
            val toneLabels = mapOf("casual" to "Casual", "formal" to "Formal", "brief" to "Brief")
            val tabViews = mutableMapOf<String, TextView>()

            if (available.size > 1) {
                available.forEach { tone ->
                    val tab = TextView(this@ProTxtAccessibilityService).apply {
                        text = toneLabels[tone]
                        textSize = 12f
                        setPadding(dp(8), dp(2), dp(8), dp(2))
                        setOnClickListener {
                            selectedTone = tone
                            replyView.text = tones[tone]
                            tabViews.forEach { (t, v) ->
                                val active = t == tone
                                v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                                v.setTextColor(if (active) PURPLE else MUTED)
                                v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
                            }
                        }
                    }
                    tabViews[tone] = tab
                    addView(tab)
                }
                // Apply initial tab styles
                tabViews.forEach { (tone, v) ->
                    val active = tone == selectedTone
                    v.setBackgroundColor(if (active) PURPLE_BG else Color.TRANSPARENT)
                    v.setTextColor(if (active) PURPLE else MUTED)
                    v.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
                }

                // Spacer pushes actions to right
                addView(View(this@ProTxtAccessibilityService).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
                })
            }

            // Share Location button — only shown when the suggested action is share_location
            if (pendingAction?.optString("type") == "share_location") {
                addView(TextView(this@ProTxtAccessibilityService).apply {
                    text = "📍 Location"
                    setTextColor(Color.parseColor("#22c55e"))
                    textSize = 13f
                    setTypeface(null, Typeface.BOLD)
                    setPadding(dp(12), 0, dp(4), 0)
                    setOnClickListener {
                        val lat = pendingAction?.optDouble("lat", Double.NaN) ?: Double.NaN
                        val lon = pendingAction?.optDouble("lon", Double.NaN) ?: Double.NaN
                        if (!lat.isNaN() && !lon.isNaN()) {
                            val area = pendingAction?.optString("area")?.ifEmpty { null }
                            val mapsUrl = "https://maps.google.com/?q=$lat,$lon"
                            val msg = if (area != null) "I'm currently in $area: $mapsUrl" else mapsUrl
                            injectText(msg)
                            recordOverlaySend(packageName, msg, "share_location")
                            clearAndDismiss(packageName)
                        } else {
                            android.widget.Toast.makeText(
                                this@ProTxtAccessibilityService, "Location not available yet",
                                android.widget.Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                })
            }

            // Use button
            addView(TextView(this@ProTxtAccessibilityService).apply {
                text = "Use"
                setTextColor(PURPLE)
                textSize = 14f
                setTypeface(null, Typeface.BOLD)
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener {
                    val replyText = tones[selectedTone] ?: return@setOnClickListener
                    injectText(replyText)
                    recordOverlaySend(packageName, replyText, selectedTone)
                    clearAndDismiss(packageName)
                }
            })

            // Dismiss button
            addView(TextView(this@ProTxtAccessibilityService).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 14f
                setOnClickListener {
                    val suggestion = tones["casual"] ?: tones[selectedTone] ?: ""
                    recordOverlayDismiss(packageName, suggestion)
                    clearAndDismiss(packageName)
                }
            })
        })

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.BOTTOM
            y = keyboardHeight() + dp(8)
        }

        try {
            windowManager?.addView(root, params)
            overlayView = root
            overlayParams = params
            cancelPendingNotification(packageName)
        } catch (_: Exception) {}
    }

    private fun updateOverlayPosition() {
        val view = overlayView ?: return
        val params = overlayParams ?: return
        val d = resources.displayMetrics.density
        val newY = keyboardHeight() + (8 * d).toInt()
        if (newY != params.y) {
            params.y = newY
            try { windowManager?.updateViewLayout(view, params) } catch (_: Exception) {}
        }
    }

    private fun keyboardHeight(): Int {
        val d = resources.displayMetrics.density
        val imeWindow = windows?.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            ?: return (265 * d).toInt()
        val bounds = Rect()
        imeWindow.getBoundsInScreen(bounds)
        val screenHeight = resources.displayMetrics.heightPixels
        return (screenHeight - bounds.top).coerceAtLeast((200 * d).toInt())
    }

    private fun injectText(text: String) {
        val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        if (focused.isEditable) {
            val args = Bundle()
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }
        @Suppress("DEPRECATION") focused.recycle()
    }

    // Opportunistically reads the input field text just before (or just after) the user
    // taps send in the messaging app. WhatsApp clears the field on send, so this may
    // return empty — that's fine, saveLastSent is a no-op on blank.
    private fun captureInputFieldText(packageName: String, convKey: String) {
        val inputViewId = when (packageName) {
            "com.whatsapp"     -> "com.whatsapp:id/entry"
            "com.whatsapp.w4b" -> "com.whatsapp.w4b:id/entry"
            else -> return
        }
        val root = rootInActiveWindow ?: return
        val nodes = root.findAccessibilityNodeInfosByViewId(inputViewId)
        val text = nodes.firstOrNull()?.text?.toString()
        nodes.forEach { @Suppress("DEPRECATION") it.recycle() }
        @Suppress("DEPRECATION") root.recycle()
        if (!text.isNullOrBlank()) {
            ContactMemory.saveLastSent(this, convKey, text)
        }
    }

    private fun recordOverlaySend(packageName: String, replyText: String, tone: String) {
        val prefs = Prefs.main(this)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return
        val casual  = prefs.getString("last_suggestion_$packageName", null) ?: return
        StyleEditQueue.enqueue(this, casual, replyText, convKey, tone)
        ContactMemory.saveLastSent(this, convKey, replyText)
        NotificationStore.getInstance(this).markReplied(convKey)
    }

    private fun recordOverlayDismiss(packageName: String, suggestion: String) {
        val prefs = Prefs.main(this)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return
        if (suggestion.isNotEmpty()) {
            StyleEditQueue.enqueue(this, suggestion, "", convKey, "dismissed")
        }
        ContactMemory.clearLastSent(this, convKey)
    }

    private fun clearSuggestionPrefs(packageName: String) {
        val prefs = Prefs.main(this)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null)
        prefs.edit()
            .remove("last_suggestion_$packageName")
            .remove("last_suggestion_formal_$packageName")
            .remove("last_suggestion_brief_$packageName")
            .remove("last_suggestion_ts_$packageName")
            .remove("last_suggestion_conv_$packageName")
            .apply()
        // Clear activeBubbles so the next message triggers a fresh suggestion cycle.
        // Without this, activeBubbles.contains(convKey) stays true after navigation
        // and the debounce callback exits early, producing no bubble or overlay.
        if (convKey != null) {
            ProTxtBgService.getInstance()?.activeBubbles?.remove(convKey)
        }
    }

    private fun clearAndDismiss(packageName: String) {
        clearSuggestionPrefs(packageName)
        dismissOverlay()
    }

    private fun cancelPendingNotification(packageName: String) {
        val convKey = Prefs.main(this)
            .getString("last_suggestion_conv_$packageName", null) ?: return
        val notifId = convKey.hashCode().and(0x7FFFFFFF)
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
    }

    private fun dismissOverlay() {
        overlayView?.let {
            try { windowManager?.removeView(it) } catch (_: Exception) {}
            overlayView = null
            overlayParams = null
        }
    }

    override fun onInterrupt() = dismissOverlay()

    override fun onDestroy() {
        super.onDestroy()
        onSuggestionReady = null
        activePackage = null
        dismissOverlay()
    }
}
