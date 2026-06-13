package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class WorkerResult(val replies: JSONObject, val intent: String?, val contextUpdate: String?, val action: JSONObject? = null)

object WorkerClient {

    private const val MAX_RETRIES = 2
    private const val RETRY_DELAY_MS = 1_000L

    fun call(
        context: Context,
        message: String,
        thread: List<Pair<String?, String>>,
        enrichments: JSONObject = JSONObject(),
        regenerate: Boolean = false,
        contactMemory: String? = null,
        lastSentReply: String? = null,
    ): WorkerResult? {
        val prefs = context.getSharedPreferences("contextreply_prefs", Context.MODE_PRIVATE)
        val styleProfile      = prefs.getString("style_profile", null)
        val nativeRecentEdits = prefs.getString("native_recent_edits", null)
        // Merge JS-built profile with edits not yet synced (written by NativeStyleSync after each send)
        val fullStyleContext = listOfNotNull(
            styleProfile,
            nativeRecentEdits?.let { "Most recent edits (not yet reflected in full profile):\n$it" }
        ).joinToString("\n\n").ifEmpty { null }

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
            if (fullStyleContext != null) put("styleContext", fullStyleContext)
            if (enrichments.length() > 0) put("enrichments", enrichments)
            if (regenerate) put("regenerate", true)
            if (contactMemory != null) put("contactMemory", contactMemory)
            if (lastSentReply != null) put("lastSentReply", lastSentReply)
        }.toString()

        var lastException: Exception? = null
        for (retry in 0..MAX_RETRIES) {
            if (retry > 0) Thread.sleep(RETRY_DELAY_MS)
            try {
                val result = makeRequest(body)
                if (result != null) return result
                // null means a 4xx — don't retry
                return null
            } catch (e: IOException) {
                lastException = e
                // retry on network errors
            } catch (e: RetryableException) {
                lastException = e
                // retry on 5xx
            }
        }
        if (BuildConfig.DEBUG) android.util.Log.w("WorkerClient", "all retries exhausted: ${lastException?.message}")
        return null
    }

    private class RetryableException(message: String) : Exception(message)

    private fun makeRequest(body: String): WorkerResult? {
        val conn = URL("${BuildConfig.WORKER_URL}/suggest").openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-App-Secret", BuildConfig.WORKER_SECRET)
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000

            conn.outputStream.bufferedWriter().use { it.write(body) }

            val code = conn.responseCode
            if (code >= 500) {
                conn.errorStream?.use { it.readBytes() }
                throw RetryableException("HTTP $code")
            }
            if (code != 200) {
                conn.errorStream?.use { it.readBytes() }
                return null
            }
            val response = conn.inputStream.bufferedReader().use { it.readText() }
            val obj = JSONObject(response)
            val replies = obj.optJSONObject("replies") ?: return null
            val intent = obj.optString("intent").ifEmpty { null }
            val contextUpdate = obj.optString("contextUpdate").ifEmpty { null }
            val action = obj.optJSONObject("action")
            WorkerResult(replies, intent, contextUpdate, action)
        } finally {
            conn.disconnect()
        }
    }
}
