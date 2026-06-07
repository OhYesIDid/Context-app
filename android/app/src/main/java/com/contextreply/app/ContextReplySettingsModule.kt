package com.contextreply.app

import android.content.Context
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

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
}
