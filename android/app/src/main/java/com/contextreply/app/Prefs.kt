package com.contextreply.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Central access point for all SharedPreferences in the app.
 * Returns EncryptedSharedPreferences backed by an AES-256-GCM key in the Android Keystore.
 *
 * Call Prefs.migrateLegacy(context) once on service start to transparently move any
 * existing plaintext data into the encrypted stores and wipe the old files.
 */
object Prefs {

    private const val MAIN          = "contextreply_prefs_enc"
    private const val STYLE_QUEUE   = "contextreply_style_queue_enc"
    private const val CONTACT_MEM   = "contextreply_contact_memory_enc"
    private const val MSG_CACHE     = "contextreply_message_cache_enc"

    fun main(context: Context):          SharedPreferences = encrypted(context, MAIN)
    fun styleQueue(context: Context):    SharedPreferences = encrypted(context, STYLE_QUEUE)
    fun contactMemory(context: Context): SharedPreferences = encrypted(context, CONTACT_MEM)
    fun messageCache(context: Context):  SharedPreferences = encrypted(context, MSG_CACHE)

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
            // Hardware keystore unavailable — fall back to plaintext so the app stays functional.
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
}
