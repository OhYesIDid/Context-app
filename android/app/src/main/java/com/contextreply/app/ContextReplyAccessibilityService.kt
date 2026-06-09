package com.contextreply.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.TextView

class ContextReplyAccessibilityService : AccessibilityService() {

    companion object {
        private const val PREFS_NAME = "contextreply_prefs"
        private const val MAX_AGE_MS = 5 * 60 * 1000L

        // Set to the foreground messaging package while user is in the app.
        // Read by ContextReplyBgService to skip the bubble and route to the overlay instead.
        @Volatile var activePackage: String? = null

        // Invoked by ContextReplyBgService (on the worker thread) when a suggestion is ready.
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

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        onSuggestionReady = { pkg ->
            if (activePackage == pkg) mainHandler.post { maybeShowOverlay(pkg) }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return

        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (pkg in ContextReplyBgService.TARGET_PACKAGES) {
                    // Clear cached suggestion on any in-app navigation so the next
                    // conversation doesn't inherit a stale reply from a different chat.
                    // Do NOT set activePackage here — TYPE_WINDOW_STATE_CHANGED fires
                    // for background WhatsApp events (sync, etc.) that don't mean the
                    // user is in the app. activePackage is set only in TYPE_VIEW_FOCUSED
                    // when an editable field is focused (keyboard is up).
                    clearSuggestionPrefs(pkg)
                    dismissOverlay()
                }
                // Ignore IME/system packages — TYPE_WINDOWS_CHANGED handles "left the app".
            }
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> {
                if (activePackage == null) return
                val targetVisible = windows?.any { w ->
                    val root = w.root
                    val match = w.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                            root?.packageName?.toString() == activePackage
                    @Suppress("DEPRECATION") root?.recycle()
                    match
                } == true
                if (!targetVisible) {
                    activePackage = null
                    dismissOverlay()
                } else if (overlayView != null) {
                    // Keyboard may have appeared/resized — update overlay Y position
                    updateOverlayPosition()
                }
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> {
                val node = event.source ?: return
                val editable = node.isEditable
                @Suppress("DEPRECATION") node.recycle()
                if (pkg !in ContextReplyBgService.TARGET_PACKAGES || !editable) return
                activePackage = pkg

                // Auto-inject suggestion when user tapped "open chat" from the bubble
                val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val pendingText = prefs.getString("pending_inject_$pkg", null)
                if (pendingText != null) {
                    prefs.edit().remove("pending_inject_$pkg").apply()
                    injectText(pendingText)
                    clearAndDismiss(pkg)
                    return
                }

                if (overlayView == null) maybeShowOverlay(pkg)
            }
        }
    }

    private fun maybeShowOverlay(packageName: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val casual = prefs.getString("last_suggestion_$packageName", null)?.takeIf { it.isNotEmpty() }
            ?: return
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        if (age > MAX_AGE_MS) return

        val formal = prefs.getString("last_suggestion_formal_$packageName", null)?.takeIf { it.isNotEmpty() }
        val brief  = prefs.getString("last_suggestion_brief_$packageName", null)?.takeIf { it.isNotEmpty() }

        tones = buildMap {
            put("casual", casual)
            if (formal != null) put("formal", formal)
            if (brief  != null) put("brief", brief)
        }
        selectedTone = if (tones.containsKey("casual")) "casual" else tones.keys.first()
        showOverlay(packageName)
    }

    private fun showOverlay(packageName: String) {
        dismissOverlay()
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
            elevation = dp(6).toFloat()
            setPadding(dp(16), dp(10), dp(16), dp(10))
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
                    val tab = TextView(this@ContextReplyAccessibilityService).apply {
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
                addView(View(this@ContextReplyAccessibilityService).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
                })
            }

            // Use button
            addView(TextView(this@ContextReplyAccessibilityService).apply {
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
            addView(TextView(this@ContextReplyAccessibilityService).apply {
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

    private fun recordOverlaySend(packageName: String, replyText: String, tone: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return
        val casual  = prefs.getString("last_suggestion_$packageName", null) ?: return
        StyleEditQueue.enqueue(this, casual, replyText, convKey, tone)
        ContactMemory.saveLastSent(this, convKey, replyText)
        NotificationStore.getInstance(this).markReplied(convKey)
    }

    private fun recordOverlayDismiss(packageName: String, suggestion: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return
        if (suggestion.isNotEmpty()) {
            StyleEditQueue.enqueue(this, suggestion, "", convKey, "dismissed")
        }
        ContactMemory.clearLastSent(this, convKey)
    }

    private fun clearSuggestionPrefs(packageName: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
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
            ContextReplyBgService.getInstance()?.activeBubbles?.remove(convKey)
        }
    }

    private fun clearAndDismiss(packageName: String) {
        clearSuggestionPrefs(packageName)
        dismissOverlay()
    }

    private fun cancelPendingNotification(packageName: String) {
        val convKey = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
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
