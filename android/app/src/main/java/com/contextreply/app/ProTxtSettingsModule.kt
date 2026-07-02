package com.contextreply.app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import org.json.JSONArray
import org.json.JSONObject

class ProTxtSettingsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ProTxtSettings"

    @ReactMethod
    fun refreshBubbleState() {
        ProTxtBgService.getInstance()?.downgradeBubblesIfNeeded()
    }

    @ReactMethod
    fun setSkipGroupMessages(skip: Boolean) {
        Prefs.main(reactApplicationContext)
            .edit()
            .putBoolean("skip_group_messages", skip)
            .apply()
        if (skip) ProTxtBgService.getInstance()?.dismissAllGroupBubbles()
        else ProTxtBgService.getInstance()?.activateGroupNotifications()
    }

    @ReactMethod
    fun getSkipGroupMessages(promise: Promise) {
        val skip = Prefs.main(reactApplicationContext)
            .getBoolean("skip_group_messages", true)
        promise.resolve(skip)
    }

    @ReactMethod
    fun setRemindersEnabled(enabled: Boolean) {
        Prefs.main(reactApplicationContext)
            .edit().putBoolean("reminders_enabled", enabled).apply()
    }

    @ReactMethod
    fun getRemindersEnabled(promise: Promise) {
        promise.resolve(Prefs.main(reactApplicationContext).getBoolean("reminders_enabled", true))
    }

    @ReactMethod
    fun setSuggestAllMessages(all: Boolean) {
        Prefs.main(reactApplicationContext)
            .edit()
            .putBoolean("suggest_all_messages", all)
            .apply()
        val svc = ProTxtBgService.getInstance()
        if (all) svc?.replayActiveNotifications()
        else svc?.dismissOtherIntentBubbles()
    }

    @ReactMethod
    fun getSuggestAllMessages(promise: Promise) {
        val all = Prefs.main(reactApplicationContext)
            .getBoolean("suggest_all_messages", false)
        promise.resolve(all)
    }

    @ReactMethod
    fun isNlsConnected(promise: Promise) {
        val listeners = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            "enabled_notification_listeners"
        ) ?: ""
        val pkg = reactApplicationContext.packageName
        promise.resolve(listeners.contains("$pkg/com.contextreply.app.ProTxtBgService"))
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

    @ReactMethod
    fun getEnrichmentPreference(enrichment: String, key: String, promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        val value = try {
            val obj = JSONObject(prefs.getString("enrichment_prefs", "{}") ?: "{}")
            obj.optJSONObject(enrichment)?.optString(key)?.ifEmpty { null }
        } catch (_: Exception) { null }
        promise.resolve(value)
    }

    @ReactMethod
    fun setEnrichmentPreference(enrichment: String, key: String, value: String) {
        val prefs = Prefs.main(reactApplicationContext)
        try {
            val obj = JSONObject(prefs.getString("enrichment_prefs", "{}") ?: "{}")
            val enrichmentObj = obj.optJSONObject(enrichment) ?: JSONObject()
            enrichmentObj.put(key, value)
            obj.put(enrichment, enrichmentObj)
            prefs.edit().putString("enrichment_prefs", obj.toString()).apply()
        } catch (_: Exception) {}
    }

    // Returns current pending calendar actions as a JSON array without clearing them.
    @ReactMethod
    fun getPendingCalendarActions(promise: Promise) {
        val json = Prefs.main(reactApplicationContext)
            .getString("pending_calendar_actions", "[]") ?: "[]"
        promise.resolve(json)
    }

    // Removes a single pending calendar action by id.
    @ReactMethod
    fun clearPendingCalendarAction(id: String) {
        val prefs = Prefs.main(reactApplicationContext)
        try {
            val arr = JSONArray(prefs.getString("pending_calendar_actions", "[]") ?: "[]")
            val next = JSONArray()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            prefs.edit().putString("pending_calendar_actions", next.toString()).apply()
        } catch (_: Exception) {}
    }

    // Atomically reads and clears the pending_contacts queue, returning a JSON
    // array of {convKey, senderName, platform} objects for JS to process.
    @ReactMethod
    fun drainPendingContacts(promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        val json = prefs.getString("pending_contacts", "[]") ?: "[]"
        prefs.edit().putString("pending_contacts", "[]").apply()
        promise.resolve(json)
    }

    // Atomically reads and clears the StyleEditQueue SharedPrefs, returning
    // the raw JSON array string so JS can drain it into SQLite.
    @ReactMethod
    fun drainStyleQueue(promise: Promise) {
        val prefs = Prefs.styleQueue(reactApplicationContext)
        val json = prefs.getString("queue", "[]") ?: "[]"
        prefs.edit().putString("queue", "[]").apply()
        promise.resolve(json)
    }

    // Atomically reads and clears intent corrections logged by BubbleSuggestionActivity.
    // Returns a JSON array of {ts, from[], to[], message} objects.
    @ReactMethod
    fun drainIntentCorrections(promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        val json = prefs.getString("intent_corrections", "[]") ?: "[]"
        prefs.edit().putString("intent_corrections", "[]").apply()
        promise.resolve(json)
    }

    // Stores a JSON map of {contactName(lowercase): preferredTone} so BgService
    // can pre-select the right tone tab when posting a bubble for a known contact.
    @ReactMethod
    fun cacheContactTones(json: String) {
        Prefs.main(reactApplicationContext)
            .edit().putString("contact_tone_map", json).apply()
    }

    // Returns the confirmed_identities map {convKey: contactId} without clearing it.
    @ReactMethod
    fun getConfirmedIdentities(promise: Promise) {
        val json = Prefs.main(reactApplicationContext)
            .getString("confirmed_identities", "{}") ?: "{}"
        promise.resolve(json)
    }

    // Writes confirmed_identities back into SharedPrefs — used after reinstall
    // to restore from the SQLite platform_identities source of truth.
    @ReactMethod
    fun restoreConfirmedIdentities(json: String) {
        Prefs.main(reactApplicationContext)
            .edit().putString("confirmed_identities", json).apply()
    }

    // Stores the full contact list as a JSON array so ContactMatcher can do
    // fuzzy name matching against it from the background service.
    @ReactMethod
    fun cacheContactList(json: String) {
        Prefs.main(reactApplicationContext)
            .edit().putString("contact_cache", json).apply()
    }

    // JS calls this after rebuilding the style profile from SQLite so the
    // Kotlin worker path can include it in the next /suggest request.
    @ReactMethod
    fun cacheStyleProfile(profile: String) {
        Prefs.main(reactApplicationContext)
            .edit().putString("style_profile", profile).apply()
    }

    @ReactMethod
    fun getSavedHome(promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        if (!prefs.contains("home_lat")) { promise.resolve(null); return }
        promise.resolve(JSONObject().apply {
            put("lat", prefs.getFloat("home_lat", 0f).toDouble())
            put("lon", prefs.getFloat("home_lon", 0f).toDouble())
        }.toString())
    }

    @ReactMethod
    fun clearSavedHome() {
        Prefs.main(reactApplicationContext).edit()
            .remove("home_lat")
            .remove("home_lon")
            .remove(HomeDetectionWorker.FIXES_KEY)
            .remove("home_detect_dismissed")
            .apply()
        HomeDetectionWorker.schedule(reactApplicationContext)
    }

    @ReactMethod
    fun setProStatus(active: Boolean) {
        Prefs.main(reactApplicationContext)
            .edit().putBoolean("is_pro", active).apply()
    }

    @ReactMethod
    fun setDefaultTone(tone: String) {
        Prefs.main(reactApplicationContext)
            .edit().putString("default_tone", tone).apply()
    }

    @ReactMethod
    fun isAccessibilityServiceEnabled(promise: Promise) {
        val enabled = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: ""
        promise.resolve(enabled.contains(
            "${reactApplicationContext.packageName}/com.contextreply.app.ProTxtAccessibilityService"
        ))
    }

    @ReactMethod
    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactApplicationContext.startActivity(intent)
    }

    @ReactMethod
    fun openNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, reactApplicationContext.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactApplicationContext.startActivity(intent)
    }

    @ReactMethod
    fun openInputMethodSettings() {
        val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactApplicationContext.startActivity(intent)
    }

    @ReactMethod
    fun isConTxtKeyboardDefault(promise: Promise) {
        val defaultIme = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            Settings.Secure.DEFAULT_INPUT_METHOD
        ) ?: ""
        promise.resolve(defaultIme.startsWith("com.contxt.keyboard"))
    }

    // ── AES-256-GCM field encryption ─────────────────────────────────────────
    // Key is generated once via SecureRandom, stored in EncryptedSharedPreferences
    // (Android Keystore-backed). IV is 12 random bytes prepended to the ciphertext.
    // Wire format: "enc1:" + Base64(iv[12] + ciphertext)

    private fun getOrCreateSecretKey(): SecretKeySpec {
        val prefs = Prefs.main(reactApplicationContext)
        val b64 = prefs.getString("db_encryption_key", null) ?: run {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            Base64.encodeToString(bytes, Base64.NO_WRAP).also { key ->
                prefs.edit().putString("db_encryption_key", key).apply()
            }
        }
        return SecretKeySpec(Base64.decode(b64, Base64.NO_WRAP), "AES")
    }

    @ReactMethod
    fun encryptText(text: String, promise: Promise) {
        try {
            val key = getOrCreateSecretKey()
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            val ct = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
            promise.resolve("enc1:" + Base64.encodeToString(iv + ct, Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("ENC_ERROR", e.message ?: "encrypt failed", e)
        }
    }

    @ReactMethod
    fun decryptText(encrypted: String, promise: Promise) {
        try {
            if (!encrypted.startsWith("enc1:")) { promise.resolve(encrypted); return }
            val combined = Base64.decode(encrypted.removePrefix("enc1:"), Base64.NO_WRAP)
            val iv = combined.sliceArray(0..11)
            val ct = combined.sliceArray(12 until combined.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
            promise.resolve(String(cipher.doFinal(ct), Charsets.UTF_8))
        } catch (e: Exception) {
            promise.reject("DEC_ERROR", e.message ?: "decrypt failed", e)
        }
    }

    // Kept for backwards compat — JS dbCrypto no longer calls this but old APKs might.
    @ReactMethod
    fun getOrCreateDbKey(promise: Promise) {
        try { promise.resolve(Base64.encodeToString(getOrCreateSecretKey().encoded, Base64.NO_WRAP)) }
        catch (e: Exception) { promise.reject("DB_KEY_ERROR", e.message ?: "failed", e) }
    }

    // HMAC-SHA256 keyed hash of (platform + ":" + identifier) using the db encryption key.
    // Used to build a stable, non-reversible lookup key for platform_identities.identifier
    // so the plaintext phone number / username never sits in a queryable column.
    @ReactMethod
    fun hmacIdentifier(value: String, promise: Promise) {
        try {
            val key = getOrCreateSecretKey()
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(key.encoded, "HmacSHA256"))
            val hash = mac.doFinal(value.toByteArray(Charsets.UTF_8))
            promise.resolve(Base64.encodeToString(hash, Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("HMAC_ERROR", e.message ?: "hmac failed", e)
        }
    }
}
