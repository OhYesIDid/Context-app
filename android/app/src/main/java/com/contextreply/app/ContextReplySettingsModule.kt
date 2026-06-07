package com.contextreply.app

import android.content.Context
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
        promise.resolve(
            listeners.contains("com.contextreply.app/com.contextreply.app.ContextReplyBgService")
        )
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
