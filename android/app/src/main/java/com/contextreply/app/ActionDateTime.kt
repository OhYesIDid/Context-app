package com.contextreply.app

import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * Parses a Claude-generated action datetime string into a local date/time. Claude is
 * instructed to return a bare ISO-8601 local datetime (e.g. "2026-06-20T19:00:00"), but
 * occasionally includes a trailing zone/offset or fractional seconds. A strict
 * LocalDateTime.parse() on those variants throws and — if the caller silently swallows
 * it — leaves a calendar action with no time set, so the Calendar app defaults the new
 * event to "now" instead of the time actually mentioned (e.g. "dinner at 8pm"). Tries
 * progressively looser parses instead of dropping the time on the first mismatch.
 */
object ActionDateTime {
    fun parse(raw: String): LocalDateTime? =
        tryParse { LocalDateTime.ofInstant(Instant.parse(raw), ZoneId.systemDefault()) }
            ?: tryParse { OffsetDateTime.parse(raw).atZoneSameInstant(ZoneId.systemDefault()).toLocalDateTime() }
            ?: tryParse { LocalDateTime.parse(raw) }
            ?: tryParse {
                val cleaned = raw
                    .replace(Regex("""\.\d+"""), "")
                    .replace(Regex("""(Z|[+-]\d{2}:?\d{2})$"""), "")
                LocalDateTime.parse(cleaned)
            }

    private fun <T> tryParse(block: () -> T): T? = try { block() } catch (_: Exception) { null }
}
