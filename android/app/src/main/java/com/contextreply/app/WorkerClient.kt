package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class WorkerResult(val replies: JSONObject, val intent: String?)

object WorkerClient {

    fun call(
        context: Context,
        message: String,
        thread: List<Pair<String?, String>>,
        enrichments: JSONObject = JSONObject(),
        regenerate: Boolean = false,
    ): WorkerResult? {
        val conn = URL("${BuildConfig.WORKER_URL}/suggest").openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000

            val styleProfile = context.getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
                .getString("style_profile", null)

            val body = JSONObject().apply {
                put("message", message)
                if (thread.isNotEmpty()) {
                    put("conversationThread", JSONArray().also { arr ->
                        thread.forEach { (sender, text) ->
                            arr.put(JSONObject().apply {
                                if (sender != null) put("sender", sender) else put("sender", JSONObject.NULL)
                                put("text", text)
                            })
                        }
                    })
                }
                if (styleProfile != null) put("styleContext", styleProfile)
                if (enrichments.length() > 0) put("enrichments", enrichments)
                if (regenerate) put("regenerate", true)
            }.toString()

            conn.outputStream.bufferedWriter().use { it.write(body) }
            if (conn.responseCode != 200) return null
            val response = conn.inputStream.bufferedReader().use { it.readText() }
            val obj = JSONObject(response)
            val replies = obj.optJSONObject("replies") ?: return null
            val intent = obj.optString("intent").ifEmpty { null }
            WorkerResult(replies, intent)
        } finally {
            conn.disconnect()
        }
    }
}
