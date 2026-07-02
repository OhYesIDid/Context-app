package com.contextreply.app

import org.json.JSONObject

/**
 * Scores how important it is for the user to reply to an incoming message/burst.
 * Complements `detectEmotionalCharge` (per-message tone) with signals it can't see:
 * rapid-fire arrival cadence and how long a conversation has sat unanswered. Feeds
 * both the pending-replies queue (`ProTxtBgService.upsertPendingReply`) and, via
 * `WorkerClient`, extra context for the reply prompt.
 */
object MessageImportance {

    enum class Level { URGENT, ELEVATED, NORMAL }

    data class Result(val level: Level, val reasons: List<String>) {
        val levelKey: String get() = level.name.lowercase()
    }

    // Emotion tags from detectEmotionalCharge that also signal reply urgency.
    private val URGENT_EMOTIONS = setOf("urgency", "anger", "anxiety")

    fun assess(
        emotion: JSONObject?,
        burstSize: Int,
        unansweredCount: Int,
        minutesWaiting: Long?,
    ): Result {
        var score = 0
        val reasons = mutableListOf<String>()

        val emotionTag = emotion?.optString("emotion")?.takeIf { it.isNotEmpty() }
        if (emotionTag != null && URGENT_EMOTIONS.contains(emotionTag)) {
            score += if (emotion?.optString("confidence") == "high") 2 else 1
            reasons += when (emotionTag) {
                "urgency" -> "urgent language"
                "anger"   -> "message reads as upset"
                else      -> "message reads as anxious"
            }
        }
        if (burstSize >= 3) {
            score += 1
            reasons += "$burstSize messages in a row"
        }
        if (unansweredCount >= 3) {
            score += 1
            reasons += "$unansweredCount unanswered messages"
        }
        if (minutesWaiting != null && minutesWaiting >= 120) {
            score += 1
            reasons += "waiting ${minutesWaiting / 60}h+ for a reply"
        }

        val level = when {
            score >= 3 -> Level.URGENT
            score >= 1 -> Level.ELEVATED
            else       -> Level.NORMAL
        }
        return Result(level, reasons)
    }
}
