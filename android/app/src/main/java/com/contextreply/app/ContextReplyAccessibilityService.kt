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
                } else if (overlayView != null) {
                    updateOverlayPosition()
                }
            } else {
                // Not currently tracking — dismiss any stale overlay then check if the user
                // just gesture-switched back to a messaging app conversation.
                if (overlayView != null) { dismissOverlay(); return }
                val returnedPkg = ContextReplyBgService.TARGET_PACKAGES.firstOrNull { pkg ->
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
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (pkg !in ContextReplyBgService.TARGET_PACKAGES) return
                if (overlayView != null) {
                    // Dismiss if user navigated away from the correct conversation
                    if (!isInCorrectConversation(pkg)) dismissOverlay()
                } else {
                    scheduleReshow(pkg)
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

                if (overlayView == null && isInCorrectConversation(pkg)) {
                    maybeShowOverlay(pkg)
                }
            }
        }
    }

    // Returns true if the contact name from the pending suggestion is visible in the
    // action bar of the messaging app window — i.e. the user is in the right conversation.
    // For group: / id: keys we can't verify so we allow the overlay through.
    private fun isInCorrectConversation(packageName: String): Boolean {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: return false
        val contactRaw = convKey.substringAfter(":")
        if (contactRaw.startsWith("group:") || contactRaw.startsWith("id:")) return true
        val contact = contactRaw.lowercase()

        // Find the application window for the messaging app
        var root: AccessibilityNodeInfo? = null
        for (w in windows ?: return false) {
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val r = w.root ?: continue
            if (r.packageName?.toString() == packageName) { root = r; break }
            @Suppress("DEPRECATION") r.recycle()
        }
        root ?: return false

        // Search only the action bar area (top 20% of screen) for the contact name
        val topCutoff = (resources.displayMetrics.heightPixels * 0.20).toInt()
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

    private fun maybeShowOverlay(packageName: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val casual = prefs.getString("last_suggestion_$packageName", null)?.takeIf { it.isNotEmpty() }
            ?: return
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        if (age > MAX_AGE_MS) return

        val convKey = prefs.getString("last_suggestion_conv_$packageName", null) ?: ""
        currentContact = convKey.substringAfter(":").let { key ->
            when {
                key.startsWith("group:") -> "Group chat"
                key.startsWith("id:") -> ""
                else -> key.take(40)
            }
        }

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

    // Schedules an attempt to show the overlay for `pkg`. Uses `isInCorrectConversation` as
    // the sole gate — deliberately does NOT guard on `activePackage` because intermediate
    // TYPE_WINDOWS_CHANGED events during a gesture transition can clear it before the callback fires.
    // Retries once after +500 ms in case the accessibility tree isn't populated yet.
    private fun scheduleReshow(pkg: String) {
        activePackage = pkg
        mainHandler.postDelayed({
            if (overlayView != null) return@postDelayed
            if (isInCorrectConversation(pkg)) {
                activePackage = pkg
                maybeShowOverlay(pkg)
            } else {
                mainHandler.postDelayed({
                    if (overlayView == null && isInCorrectConversation(pkg)) {
                        activePackage = pkg
                        maybeShowOverlay(pkg)
                    }
                }, 500)
            }
        }, 300)
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
