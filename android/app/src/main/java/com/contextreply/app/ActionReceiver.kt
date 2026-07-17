package com.contextreply.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import java.time.ZoneId

class ActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_CALENDAR_ADD = "com.contxt.app.ACTION_CALENDAR_ADD"
        const val ACTION_MAPS_OPEN    = "com.contxt.app.ACTION_MAPS_OPEN"
        const val EXTRA_TITLE             = "action_title"
        const val EXTRA_DATETIME          = "action_datetime"
        const val EXTRA_DURATION_MINUTES  = "action_duration_minutes"
        const val EXTRA_ADDRESS           = "action_address"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_CALENDAR_ADD -> {
                val title = intent.getStringExtra(EXTRA_TITLE) ?: return
                val datetimeStr = intent.getStringExtra(EXTRA_DATETIME)
                val durationMinutes = intent.getIntExtra(EXTRA_DURATION_MINUTES, 60)

                val calIntent = Intent(Intent.ACTION_INSERT).apply {
                    data = CalendarContract.Events.CONTENT_URI
                    putExtra(CalendarContract.Events.TITLE, title)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    if (!datetimeStr.isNullOrEmpty()) {
                        val startMillis = parseEventStartMillis(datetimeStr)
                        if (startMillis != null) {
                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMillis + durationMinutes * 60_000L)
                        } else {
                            // Previously failed silently here, leaving both extras unset — the
                            // Calendar app then defaults the new event to "now", which looks to
                            // the user like it picked up the message's arrival time instead of
                            // the time actually mentioned (e.g. "dinner at 8pm").
                            android.util.Log.w("ActionReceiver", "Failed to parse action datetime: $datetimeStr")
                        }
                    }
                }
                try { context.startActivity(calIntent) } catch (_: Exception) {}
            }

            ACTION_MAPS_OPEN -> {
                val address = intent.getStringExtra(EXTRA_ADDRESS) ?: return
                val mapsIntent = Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=${Uri.encode(address)}")).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                try { context.startActivity(mapsIntent) } catch (_: Exception) {}
            }
        }
    }

    private fun parseEventStartMillis(datetimeStr: String): Long? =
        ActionDateTime.parse(datetimeStr)?.atZone(ZoneId.systemDefault())?.toInstant()?.toEpochMilli()
}
