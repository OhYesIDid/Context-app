package com.contextreply.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import com.google.firebase.crashlytics.FirebaseCrashlytics
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class WorkerResult(
    val replies: JSONObject,
    val intent: String?,
    val contextUpdate: String?,
    val action: JSONObject? = null,
    val snippets: List<String> = emptyList(),
    val rateLimited: Boolean = false,
) {
    companion object {
        val RATE_LIMITED = WorkerResult(JSONObject(), null, null, rateLimited = true)
    }
}

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
        contactContext: String? = null,
        contactName: String? = null,
        strategy: String? = null,
        mentionHint: String? = null,
        urgent: Boolean = false,
    ): WorkerResult? {
        val prefs = Prefs.main(context)
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
            if (contactContext != null) put("contactContext", contactContext)
            if (contactName != null) put("contactName", contactName)
            if (strategy != null) put("strategy", strategy)
            if (mentionHint != null) put("mentionHint", mentionHint)
            if (urgent) put("urgent", true)
        }.toString()

        var lastException: Exception? = null
        for (retry in 0..MAX_RETRIES) {
            if (retry > 0) Thread.sleep(RETRY_DELAY_MS)
            try {
                val result = makeRequest(body)
                if (result != null) return result
                // null means a 4xx — don't retry
                return null
            } catch (e: java.net.SocketTimeoutException) {
                // Don't retry on timeout — request reached the worker, Claude is just slow.
                // Fail immediately so the watchdog shows the Retry button without a 45s wait.
                return null
            } catch (e: IOException) {
                lastException = e
                // retry on network errors (connection refused, DNS, etc.)
            } catch (e: RetryableException) {
                lastException = e
                // retry on 5xx
            }
        }
        if (BuildConfig.DEBUG) android.util.Log.w("WorkerClient", "all retries exhausted: ${lastException?.message}")
        return null
    }

    private class RetryableException(message: String) : Exception(message)

    private fun hmacSha256(secret: String, data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    private fun makeRequest(body: String): WorkerResult? {
        val conn = URL("${BuildConfig.WORKER_URL}/suggest").openConnection() as HttpURLConnection
        return try {
            val timestamp = (System.currentTimeMillis() / 1000L).toString()
            val signature = if (BuildConfig.WORKER_SECRET.isNotEmpty())
                hmacSha256(BuildConfig.WORKER_SECRET, "$timestamp.$body") else ""
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Timestamp", timestamp)
            if (signature.isNotEmpty()) conn.setRequestProperty("X-Signature", signature)
            conn.doOutput = true
            conn.connectTimeout = 10_000
            conn.readTimeout = 28_000

            conn.outputStream.bufferedWriter().use { it.write(body) }

            val code = conn.responseCode
            if (code >= 500) {
                conn.errorStream?.use { it.readBytes() }
                throw RetryableException("HTTP $code")
            }
            if (code == 429) {
                conn.errorStream?.use { it.readBytes() }
                return WorkerResult.RATE_LIMITED
            }
            if (code != 200) {
                val errorBody = conn.errorStream?.use { it.bufferedReader().readText() } ?: ""
                android.util.Log.e("WorkerClient", "HTTP $code: $errorBody")
                FirebaseCrashlytics.getInstance().recordException(Exception("Worker HTTP $code: ${errorBody.take(200)}"))
                return null
            }
            val response = conn.inputStream.bufferedReader().use { it.readText() }
            val obj = JSONObject(response)
            val replies = obj.optJSONObject("replies") ?: return null
            val intent = obj.optString("intent").ifEmpty { null }
            val contextUpdate = obj.optString("contextUpdate").ifEmpty { null }
            val action = obj.optJSONObject("action")
            val snippetsArr = obj.optJSONArray("snippets")
            val snippets = if (snippetsArr != null) {
                (0 until snippetsArr.length()).mapNotNull {
                    snippetsArr.optString(it).ifEmpty { null }
                }
            } else emptyList()
            WorkerResult(replies, intent, contextUpdate, action, snippets)
        } finally {
            conn.disconnect()
        }
    }
}
