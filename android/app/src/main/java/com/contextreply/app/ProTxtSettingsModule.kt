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
import com.google.firebase.crashlytics.FirebaseCrashlytics
import org.json.JSONArray
import org.json.JSONObject

class ProTxtSettingsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ProTxtSettings"

    // Plain Linking.openURL() on a mail.google.com link resolves to whatever
    // browser is the device's default https handler, not Gmail — confirmed
    // via `adb shell pm get-app-links com.google.android.gm`, which doesn't
    // even list mail.google.com among Gmail's declared App Link domains, so
    // there's no "open by default" setting to enable either. Explicitly
    // targeting Gmail's package bypasses App Link verification entirely —
    // Android only needs a matching intent-filter to exist for an
    // explicitly-package-targeted intent to resolve, verified or not.
    @ReactMethod
    fun openUrlInGmail(url: String, promise: Promise) {
        try {
            val gmailIntent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
            gmailIntent.setPackage("com.google.android.gm")
            gmailIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(gmailIntent)
            promise.resolve(true)
        } catch (e: Exception) {
            // Gmail not installed or no matching intent-filter — fall back
            // to normal resolution (whatever the device's default handler is).
            try {
                val fallbackIntent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
                fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(fallbackIntent)
                promise.resolve(false)
            } catch (e2: Exception) {
                promise.reject("OPEN_URL_FAILED", e2)
            }
        }
    }

    // Signs a worker request the same way WorkerClient.kt does for the native
    // background reply-suggestion path — reused here so the JS-side booking
    // classification calls (googleBookings.ts) can pass the worker's HMAC
    // check too, without duplicating WORKER_SECRET into the JS bundle at all.
    @ReactMethod
    fun signWorkerRequest(timestamp: String, body: String, promise: Promise) {
        try {
            val secret = BuildConfig.WORKER_SECRET
            if (secret.isEmpty()) {
                promise.resolve("")
                return
            }
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            val signature = mac.doFinal("$timestamp.$body".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            promise.resolve(signature)
        } catch (e: Exception) {
            promise.reject("SIGN_FAILED", e)
        }
    }

    @ReactMethod
    fun refreshBubbleState() {
        ProTxtBgService.getInstance()?.downgradeBubblesIfNeeded()
    }

    @ReactMethod
    fun logEvent(name: String, params: com.facebook.react.bridge.ReadableMap?) {
        val map = mutableMapOf<String, String>()
        params?.let { rm ->
            val iterator = rm.keySetIterator()
            while (iterator.hasNextKey()) {
                val key = iterator.nextKey()
                map[key] = rm.getString(key) ?: ""
            }
        }
        Analytics.log(reactApplicationContext, name, map)
    }

    // "confirmed_identities" maps convKey -> contactId. Every sender ends up with an
    // entry almost immediately: a real contactId (banner-confirmed or auto-applied
    // high-confidence match), a "sep:*" placeholder (user explicitly chose "keep
    // separate" for a cross-app suggestion), or an "auto:*" placeholder (no contact
    // matched at all, auto-registered so the banner never re-asks). Only the "auto:*"
    // ones are genuinely unmatched — "sep:*" was a deliberate user decision, not
    // something to re-surface as needing a manual link.
    @ReactMethod
    fun getUnmatchedSenders(promise: Promise) {
        try {
            val prefs = Prefs.main(reactApplicationContext)
            val confirmed = try {
                JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
            } catch (_: Exception) { JSONObject() }
            val result = JSONArray()
            val keys = confirmed.keys()
            while (keys.hasNext()) {
                val convKey = keys.next()
                val assignedId = confirmed.optString(convKey)
                if (!assignedId.startsWith("auto:")) continue
                val packageName = convKey.substringBefore(":", "")
                val senderName = ProTxtBgService.stripAppPrefix(convKey.substringAfter(":"))
                if (packageName.isEmpty() || senderName.isEmpty()) continue
                result.put(JSONObject().apply {
                    put("convKey", convKey)
                    put("displayName", senderName)
                    put("platformLabel", ProTxtBgService.appLabel(packageName))
                    put("platform", ProTxtBgService.packageToPlatform(packageName) ?: "other")
                })
            }
            promise.resolve(result.toString())
        } catch (e: Exception) {
            promise.reject("GET_UNMATCHED_FAILED", e)
        }
    }

    // Every confirmed_identities entry pointing at a REAL contact (not an "auto:*" or
    // "sep:*" placeholder) — i.e. every cross-app link the automatic "Is this X?"
    // banner has ever confirmed, going back to before the JS-side platform_identities
    // table (used for the "ON" chip display) existed. That table has only ever been
    // written by contact import and the new manual "+ Link another app" picker — the
    // much more common automatic banner path never wrote to it — so most real,
    // long-standing links have nothing to show in the UI without this. The JS side
    // uses this to backfill platform_identities the first time a contact's profile
    // (or the contacts list) is viewed, rather than needing this on every load.
    @ReactMethod
    fun getAllConfirmedLinks(promise: Promise) {
        try {
            val prefs = Prefs.main(reactApplicationContext)
            val confirmed = try {
                JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
            } catch (_: Exception) { JSONObject() }
            val result = JSONArray()
            val keys = confirmed.keys()
            while (keys.hasNext()) {
                val convKey = keys.next()
                val contactId = confirmed.optString(convKey)
                if (contactId.startsWith("auto:") || contactId.startsWith("sep:")) continue
                val packageName = convKey.substringBefore(":", "")
                val senderName = ProTxtBgService.stripAppPrefix(convKey.substringAfter(":"))
                if (packageName.isEmpty() || senderName.isEmpty()) continue
                val platform = ProTxtBgService.packageToPlatform(packageName) ?: continue
                result.put(JSONObject().apply {
                    put("convKey", convKey)
                    put("contactId", contactId)
                    put("displayName", senderName)
                    put("platform", platform)
                })
            }
            promise.resolve(result.toString())
        } catch (e: Exception) {
            promise.reject("GET_CONFIRMED_LINKS_FAILED", e)
        }
    }

    // Re-points a convKey's confirmed_identities entry at a real contact — the same
    // write the bubble's "Yes, link" banner already does, just reached by the user
    // manually browsing unmatched senders in Settings instead of a system-suggested
    // banner. Future messages from this convKey immediately pick up the linked
    // contact's tone/relationship data (see confirmedTone() in ProTxtBgService).
    @ReactMethod
    fun linkSenderToContact(convKey: String, contactId: String, promise: Promise) {
        try {
            val prefs = Prefs.main(reactApplicationContext)
            val confirmed = try {
                JSONObject(prefs.getString("confirmed_identities", "{}") ?: "{}")
            } catch (_: Exception) { JSONObject() }
            confirmed.put(convKey, contactId)
            prefs.edit().putString("confirmed_identities", confirmed.toString()).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("LINK_SENDER_FAILED", e)
        }
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
    fun getStyleStats(promise: Promise) {
        val stats = StyleProfileBuilder.statsSnapshot(reactApplicationContext)
        promise.resolve(JSONObject().apply {
            put("editCount", stats.editCount)
            put("contactsMatched", stats.contactsMatched)
            put("hasProfile", stats.hasProfile)
        }.toString())
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
        if (!enabled) ReminderWorker.cancelAll(reactApplicationContext)
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
    fun areBubblesEnabled(promise: Promise) {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val enabled = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            nm.bubblePreference != android.app.NotificationManager.BUBBLE_PREFERENCE_NONE
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION") nm.areBubblesEnabled()
        } else {
            true // Bubbles API doesn't exist pre-R — nothing to check
        }
        promise.resolve(enabled)
    }

    @ReactMethod
    fun getBubbleSettingsLabel(promise: Promise) {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val label = when {
            manufacturer.contains("samsung") -> "Notifications → Pop-up view"
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") -> "Notifications → Floating notifications"
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> "Notifications → Floating window"
            // ColorOS (OPPO/OnePlus/Realme) doesn't surface AOSP's "Bubbles" label at
            // all — confirmed on a real OPPO CPH2791 device that the equivalent
            // toggle is under "Floating windows" instead (see project-bubble-debug memory).
            manufacturer.contains("oppo") || manufacturer.contains("oneplus") || manufacturer.contains("realme") -> "Notifications → Floating windows"
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

    @ReactMethod
    fun getPendingFollowUps(promise: Promise) {
        val json = Prefs.main(reactApplicationContext)
            .getString("pending_follow_ups", "[]") ?: "[]"
        promise.resolve(json)
    }

    @ReactMethod
    fun clearPendingFollowUp(id: String) {
        ProTxtBgService.getInstance()?.clearPendingFollowUp(id)
            ?: run {
                // Service not running — clear directly from prefs
                val prefs = Prefs.main(reactApplicationContext)
                try {
                    val arr = org.json.JSONArray(prefs.getString("pending_follow_ups", "[]") ?: "[]")
                    val next = org.json.JSONArray()
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        if (item.optString("id") != id) next.put(item)
                    }
                    prefs.edit().putString("pending_follow_ups", next.toString()).apply()
                } catch (_: Exception) {}
            }
    }

    // Atomically reads and clears follow-ups confirmed via the bubble CTA so JS can
    // drain them into AsyncStorage without showing the HomeScreen suggestion card.
    @ReactMethod
    fun drainConfirmedFollowUps(promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        val json = prefs.getString("confirmed_follow_ups", "[]") ?: "[]"
        prefs.edit().putString("confirmed_follow_ups", "[]").apply()
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
            put("area", prefs.getString("home_area", null))
        }.toString())
    }

    @ReactMethod
    fun clearSavedHome() {
        Prefs.main(reactApplicationContext).edit()
            .remove("home_lat")
            .remove("home_lon")
            .remove("home_area")
            .remove(HomeDetectionWorker.FIXES_KEY)
            .remove("home_detect_dismissed")
            .apply()
        HomeDetectionWorker.schedule(reactApplicationContext)
    }

    // ── Home candidate review (visual confirm before saving) ──────────────────

    @ReactMethod
    fun getPendingHomeCandidate(promise: Promise) {
        val prefs = Prefs.main(reactApplicationContext)
        if (!prefs.contains("home_candidate_lat")) { promise.resolve(null); return }
        promise.resolve(JSONObject().apply {
            put("lat", prefs.getFloat("home_candidate_lat", 0f).toDouble())
            put("lon", prefs.getFloat("home_candidate_lon", 0f).toDouble())
            put("area", prefs.getString("home_candidate_area", null))
        }.toString())
    }

    @ReactMethod
    fun confirmHomeLocation(lat: Double, lon: Double, area: String?) {
        HomeDetectionWorker.confirmCandidate(reactApplicationContext, lat, lon, area)
    }

    @ReactMethod
    fun dismissHomeCandidate() {
        HomeDetectionWorker.dismissCandidate(reactApplicationContext)
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
            // Most likely cause: the Keystore-backed AES key no longer matches the
            // one this row was encrypted under (e.g. a GCM auth-tag failure). Surface
            // it so a recurring pattern is visible, rather than only failing silently.
            FirebaseCrashlytics.getInstance().recordException(e)
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
