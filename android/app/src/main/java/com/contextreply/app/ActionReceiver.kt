package com.contextreply.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import java.time.LocalDateTime
import java.time.ZoneId

class ActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_CALENDAR_ADD = "com.protxt.app.ACTION_CALENDAR_ADD"
        const val ACTION_MAPS_OPEN    = "com.protxt.app.ACTION_MAPS_OPEN"
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
                        try {
                            val startMillis = LocalDateTime.parse(datetimeStr)
                                .atZone(ZoneId.systemDefault())
                                .toInstant()
                                .toEpochMilli()
                            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMillis)
                            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, startMillis + durationMinutes * 60_000L)
                        } catch (_: Exception) {}
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
}
