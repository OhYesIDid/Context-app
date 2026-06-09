package com.contextreply.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Bundle
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

    // Tone state for the currently shown overlay
    private var tones = mapOf<String, String>()   // key → text
    private var selectedTone = "casual"

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        onSuggestionReady = { pkg ->
            android.util.Log.e("ContextReply", "onSuggestionReady pkg=$pkg activePackage=$activePackage")
            if (activePackage == pkg) maybeShowOverlay(pkg)
        }
        android.util.Log.e("ContextReply", "A11y service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return

        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (pkg in ContextReplyBgService.TARGET_PACKAGES) {
                    activePackage = pkg
                    // User navigated within the app — clear cached suggestion so the
                    // next conversation doesn't see a stale reply from a different chat.
                    // The overlay re-shows when the reply field gets focus (TYPE_VIEW_FOCUSED)
                    // and a fresh suggestion exists (written by onSuggestionReady).
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
            ?: run {
                android.util.Log.e("ContextReply", "maybeShowOverlay: no suggestion cached for $packageName")
                return
            }
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        android.util.Log.e("ContextReply", "maybeShowOverlay: age=${age}ms suggestion=${casual.take(40)}")
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
                    injectText(tones[selectedTone] ?: return@setOnClickListener)
                    clearAndDismiss(packageName)
                }
            })

            // Dismiss button
            addView(TextView(this@ContextReplyAccessibilityService).apply {
                text = "Dismiss"
                setTextColor(MUTED)
                textSize = 14f
                setOnClickListener { clearAndDismiss(packageName) }
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

    private fun clearSuggestionPrefs(packageName: String) {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove("last_suggestion_$packageName")
            .remove("last_suggestion_formal_$packageName")
            .remove("last_suggestion_brief_$packageName")
            .remove("last_suggestion_ts_$packageName")
            .remove("last_suggestion_conv_$packageName")
            .apply()
    }

    private fun clearAndDismiss(packageName: String) {
        val convKey = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString("last_suggestion_conv_$packageName", null)
        clearSuggestionPrefs(packageName)
        if (convKey != null) {
            ContextReplyBgService.getInstance()?.activeBubbles?.remove(convKey)
        }
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
