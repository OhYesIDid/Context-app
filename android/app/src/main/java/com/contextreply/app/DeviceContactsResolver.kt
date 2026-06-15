package com.contextreply.app

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import org.json.JSONArray
import org.json.JSONObject

object DeviceContactsResolver {

    /** Queries ContactsContract on a background thread and caches results to SharedPrefs. */
    fun populate(context: Context) {
        Thread {
            try {
                val arr = loadFromDevice(context)
                if (arr.length() > 0) {
                    Prefs.main(context)
                        .edit().putString("device_contact_cache", arr.toString()).apply()
                }
            } catch (_: Exception) {}
        }.start()
    }

    /** Resolves a raw phone number to a contact display name via PhoneLookup (handles normalization). */
    fun phoneToDisplayName(context: Context, phone: String): String? = try {
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(phone),
        )
        context.contentResolver.query(
            uri,
            arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
            null, null, null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    } catch (_: Exception) { null }

    private fun loadFromDevice(context: Context): JSONArray {
        val arr = JSONArray()
        val cursor = context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
            "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} IS NOT NULL" +
                " AND ${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} != ''",
            null,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY + " ASC",
        ) ?: return arr
        cursor.use {
            val idCol   = it.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
            val nameCol = it.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            while (it.moveToNext()) {
                val id   = it.getString(idCol)   ?: continue
                val name = it.getString(nameCol) ?: continue
                arr.put(JSONObject().apply {
                    put("id",              "device:$id")
                    put("display_name",    name)
                    put("preferred_tone",  "")
                    put("interaction_count", 0)
                })
            }
        }
        return arr
    }
}
