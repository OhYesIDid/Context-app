package com.contextreply.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Central access point for all SharedPreferences in the app.
 * Returns EncryptedSharedPreferences backed by an AES-256-GCM key in the Android Keystore,
 * wrapped in SafeSharedPreferences so keystore failures (e.g. VERIFICATION_FAILED on some
 * OPPO/Realme devices) never propagate exceptions to callers — reads return defaults, writes
 * are silently dropped.
 */
object Prefs {

    private const val MAIN          = "contextreply_prefs_enc"
    private const val STYLE_QUEUE   = "contextreply_style_queue_enc"
    private const val CONTACT_MEM   = "contextreply_contact_memory_enc"
    private const val MSG_CACHE     = "contextreply_message_cache_enc"

    fun main(context: Context):          SharedPreferences = safe(context, MAIN)
    fun styleQueue(context: Context):    SharedPreferences = safe(context, STYLE_QUEUE)
    fun contactMemory(context: Context): SharedPreferences = safe(context, CONTACT_MEM)
    fun messageCache(context: Context):  SharedPreferences = safe(context, MSG_CACHE)

    private fun safe(context: Context, name: String): SharedPreferences =
        SafeSharedPreferences(encrypted(context, name))

    private fun encrypted(context: Context, name: String): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context.applicationContext,
                name,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
        }
    }

    /** One-time migration: copies plaintext prefs into encrypted stores then clears the old files. */
    fun migrateLegacy(context: Context) {
        migrateFile(context, "contextreply_prefs",          main(context))
        migrateFile(context, "contextreply_style_queue",    styleQueue(context))
        migrateFile(context, "contextreply_contact_memory", contactMemory(context))
        migrateFile(context, "contextreply_message_cache",  messageCache(context))
    }

    @Suppress("UNCHECKED_CAST")
    private fun migrateFile(context: Context, legacyName: String, target: SharedPreferences) {
        val legacy = context.applicationContext
            .getSharedPreferences(legacyName, Context.MODE_PRIVATE)
        if (legacy.all.isEmpty()) return
        val editor = target.edit()
        legacy.all.forEach { (k, v) ->
            when (v) {
                is String  -> editor.putString(k, v)
                is Boolean -> editor.putBoolean(k, v)
                is Int     -> editor.putInt(k, v)
                is Long    -> editor.putLong(k, v)
                is Float   -> editor.putFloat(k, v)
                is Set<*>  -> editor.putStringSet(k, v as Set<String>)
            }
        }
        editor.apply()
        legacy.edit().clear().apply()
    }

    // Wraps any SharedPreferences so that keystore failures during individual read/write
    // operations are swallowed rather than propagating to callers.
    private class SafeSharedPreferences(private val delegate: SharedPreferences) : SharedPreferences {

        override fun getAll(): Map<String, *> = try { delegate.all } catch (_: Exception) { emptyMap<String, Any>() }
        override fun getString(key: String?, defValue: String?): String? = try { delegate.getString(key, defValue) } catch (_: Exception) { defValue }
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: Set<String>?): Set<String>? = try { delegate.getStringSet(key, defValues) } catch (_: Exception) { defValues }
        override fun getInt(key: String?, defValue: Int): Int = try { delegate.getInt(key, defValue) } catch (_: Exception) { defValue }
        override fun getLong(key: String?, defValue: Long): Long = try { delegate.getLong(key, defValue) } catch (_: Exception) { defValue }
        override fun getFloat(key: String?, defValue: Float): Float = try { delegate.getFloat(key, defValue) } catch (_: Exception) { defValue }
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = try { delegate.getBoolean(key, defValue) } catch (_: Exception) { defValue }
        override fun contains(key: String?): Boolean = try { delegate.contains(key) } catch (_: Exception) { false }

        override fun edit(): SharedPreferences.Editor = SafeEditor(delegate.edit())

        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {
            try { delegate.registerOnSharedPreferenceChangeListener(listener) } catch (_: Exception) {}
        }
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {
            try { delegate.unregisterOnSharedPreferenceChangeListener(listener) } catch (_: Exception) {}
        }

        private class SafeEditor(private val delegate: SharedPreferences.Editor) : SharedPreferences.Editor {
            override fun putString(key: String?, value: String?): SharedPreferences.Editor { try { delegate.putString(key, value) } catch (_: Exception) {}; return this }
            override fun putStringSet(key: String?, values: Set<String>?): SharedPreferences.Editor { try { delegate.putStringSet(key, values) } catch (_: Exception) {}; return this }
            override fun putInt(key: String?, value: Int): SharedPreferences.Editor { try { delegate.putInt(key, value) } catch (_: Exception) {}; return this }
            override fun putLong(key: String?, value: Long): SharedPreferences.Editor { try { delegate.putLong(key, value) } catch (_: Exception) {}; return this }
            override fun putFloat(key: String?, value: Float): SharedPreferences.Editor { try { delegate.putFloat(key, value) } catch (_: Exception) {}; return this }
            override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor { try { delegate.putBoolean(key, value) } catch (_: Exception) {}; return this }
            override fun remove(key: String?): SharedPreferences.Editor { try { delegate.remove(key) } catch (_: Exception) {}; return this }
            override fun clear(): SharedPreferences.Editor { try { delegate.clear() } catch (_: Exception) {}; return this }
            override fun commit(): Boolean = try { delegate.commit() } catch (_: Exception) { false }
            override fun apply() { try { delegate.apply() } catch (_: Exception) {} }
        }
    }
}
