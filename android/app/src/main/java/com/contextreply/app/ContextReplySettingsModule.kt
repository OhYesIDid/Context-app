package com.contextreply.app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import org.json.JSONArray

class ContextReplySettingsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ContextReplySettings"

    @ReactMethod
    fun setSkipGroupMessages(skip: Boolean) {
        reactApplicationContext.getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .edit()
            .putBoolean("skip_group_messages", skip)
            .apply()
    }

    @ReactMethod
    fun getSkipGroupMessages(promise: Promise) {
        val skip = reactApplicationContext
            .getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .getBoolean("skip_group_messages", false)
        promise.resolve(skip)
    }

    @ReactMethod
    fun isNlsConnected(promise: Promise) {
        val listeners = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            "enabled_notification_listeners"
        ) ?: ""
        val pkg = reactApplicationContext.packageName
        promise.resolve(listeners.contains("$pkg/com.contextreply.app.ContextReplyBgService"))
    }

    @ReactMethod
    fun openAppNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, reactApplicationContext.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactApplicationContext.startActivity(intent)
    }

    @ReactMethod
    fun getBubbleSettingsLabel(promise: Promise) {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val label = when {
            manufacturer.contains("samsung") -> "Notifications → Pop-up view"
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") -> "Notifications → Floating notifications"
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> "Notifications → Floating window"
            else -> "Notifications → Bubbles"
        }
        promise.resolve(label)
    }

    @ReactMethod
    fun getSharedText(promise: Promise) {
        val activity = reactApplicationContext.currentActivity ?: return promise.resolve(null)
        val intent = activity.intent ?: return promise.resolve(null)
        if (Intent.ACTION_SEND != intent.action || "text/plain" != intent.type) return promise.resolve(null)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: ""
        intent.removeExtra(Intent.EXTRA_TEXT)
        promise.resolve(text.ifEmpty { null })
    }

    // Atomically reads and clears the StyleEditQueue SharedPrefs, returning
    // the raw JSON array string so JS can drain it into SQLite.
    @ReactMethod
    fun drainStyleQueue(promise: Promise) {
        val prefs = reactApplicationContext
            .getSharedPreferences("contextreply_style_queue", Context.MODE_PRIVATE)
        val json = prefs.getString("queue", "[]") ?: "[]"
        prefs.edit().putString("queue", "[]").apply()
        promise.resolve(json)
    }

    // JS calls this after rebuilding the style profile from SQLite so the
    // Kotlin worker path can include it in the next /suggest request.
    @ReactMethod
    fun cacheStyleProfile(profile: String) {
        reactApplicationContext
            .getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
            .edit().putString("style_profile", profile).apply()
    }
}
