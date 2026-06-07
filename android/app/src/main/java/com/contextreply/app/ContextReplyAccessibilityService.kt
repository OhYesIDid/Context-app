package com.contextreply.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.LinearLayout
import android.widget.TextView

class ContextReplyAccessibilityService : AccessibilityService() {

    companion object {
        private const val PREFS_NAME = "contextreply_prefs"
        private const val MAX_AGE_MS = 5 * 60 * 1000L
    }

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var activePackage: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return

        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                if (pkg in ContextReplyBgService.TARGET_PACKAGES) {
                    if (activePackage != pkg) {
                        activePackage = pkg
                        maybeShowOverlay(pkg)
                    }
                } else if (pkg != packageName) {
                    if (activePackage != null) {
                        activePackage = null
                        dismissOverlay()
                    }
                }
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> {
                val node = event.source ?: return
                val editable = node.isEditable
                @Suppress("DEPRECATION") node.recycle()
                if (pkg in ContextReplyBgService.TARGET_PACKAGES && editable && overlayView == null) {
                    activePackage = pkg
                    maybeShowOverlay(pkg)
                }
            }
        }
    }

    private fun maybeShowOverlay(packageName: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val suggestion = prefs.getString("last_suggestion_$packageName", null) ?: return
        val age = System.currentTimeMillis() - prefs.getLong("last_suggestion_ts_$packageName", 0L)
        if (age > MAX_AGE_MS) return
        showOverlay(suggestion, packageName)
    }

    private fun showOverlay(suggestion: String, packageName: String) {
        dismissOverlay()
        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#1e1e22"))
            elevation = dp(6).toFloat()
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }

        root.addView(TextView(this).apply {
            text = suggestion
            setTextColor(Color.parseColor("#f4f4f5"))
            textSize = 14f
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        })

        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)

            addView(TextView(this@ContextReplyAccessibilityService).apply {
                text = "Use"
                setTextColor(Color.parseColor("#6366f1"))
                textSize = 14f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 0, dp(24), 0)
                setOnClickListener {
                    injectText(suggestion)
                    clearAndDismiss(packageName)
                }
            })
            addView(TextView(this@ContextReplyAccessibilityService).apply {
                text = "Dismiss"
                setTextColor(Color.parseColor("#71717a"))
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
            // Position the strip above the soft keyboard.
            // Typical keyboard height is 240–290dp; 265dp covers most devices.
            y = dp(265)
        }

        try {
            windowManager?.addView(root, params)
            overlayView = root
            cancelPendingNotification(packageName)
        } catch (_: Exception) {}
    }

    private fun injectText(text: String) {
        val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        if (focused.isEditable) {
            val args = Bundle()
            args.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text
            )
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }
        @Suppress("DEPRECATION") focused.recycle()
    }

    private fun clearAndDismiss(packageName: String) {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove("last_suggestion_$packageName")
            .remove("last_suggestion_ts_$packageName")
            .remove("last_suggestion_conv_$packageName")
            .apply()
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
        }
    }

    override fun onInterrupt() = dismissOverlay()

    override fun onDestroy() {
        super.onDestroy()
        dismissOverlay()
    }
}
