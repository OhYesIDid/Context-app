package com.contextreply.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * Attaches BubbleMetadata + MessagingStyle to an existing notification builder.
 * Everything bubble-related is contained here.
 * To remove bubbles entirely: delete this file, delete BubbleSuggestionActivity.kt,
 * remove the BubbleHelper.attach() call from ContextReplyBgService, and remove
 * the BubbleSuggestionActivity entry from AndroidManifest.xml.
 */
object BubbleHelper {

    fun attach(
        context: Context,
        builder: NotificationCompat.Builder,
        replyText: String,
        formalText: String?,
        briefText: String?,
        remoteInputKey: String,
        notifId: Int,
        convKey: String,
        intentExtra: String?,
        openChatIntent: android.app.PendingIntent? = null,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return

        val contact = convKey.substringAfter(":")
        val shortcutId = "cr_conv_${convKey.hashCode().and(0x7FFFFFFF)}"
        val person = Person.Builder().setName(contact).build()
        try {
            val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
                .setLongLived(true)
                .setIntent(
                    Intent(context, BubbleSuggestionActivity::class.java)
                        .setAction(Intent.ACTION_VIEW)
                )
                .setShortLabel(contact.take(25))
                .setPerson(person)
                .setCategories(setOf("android.shortcut.conversation"))
                .build()
            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
        } catch (_: Exception) {}

        val bubbleIntent = Intent(context, BubbleSuggestionActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(ContextReplyBgService.EXTRA_REPLY_TEXT, replyText)
            putExtra(ContextReplyBgService.EXTRA_REPLY_FORMAL, formalText ?: "")
            putExtra(ContextReplyBgService.EXTRA_REPLY_BRIEF, briefText ?: "")
            putExtra(ContextReplyBgService.EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(ContextReplyBgService.EXTRA_NOTIF_ID, notifId)
            putExtra(ContextReplyBgService.EXTRA_CONV_KEY, convKey)
            if (intentExtra != null) putExtra(ContextReplyBgService.EXTRA_INTENT, intentExtra)
            if (openChatIntent != null) putExtra(ContextReplyBgService.EXTRA_OPEN_CHAT_INTENT, openChatIntent)
        }
        val bubblePi = PendingIntent.getActivity(
            context, notifId + 2, bubbleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        builder.setShortcutId(shortcutId)
        builder.setBubbleMetadata(
            NotificationCompat.BubbleMetadata.Builder(
                bubblePi,
                IconCompat.createWithResource(context, R.mipmap.ic_launcher)
            )
            .setDesiredHeight(420)
            .setAutoExpandBubble(false)
            .setSuppressNotification(true)
            .build()
        )

        // MessagingStyle is required for bubble eligibility on Android 11+
        builder.setStyle(
            NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
                .setConversationTitle(contact)
                .addMessage(
                    NotificationCompat.MessagingStyle.Message(
                        replyText,
                        System.currentTimeMillis(),
                        Person.Builder().setName("Suggested reply").build()
                    )
                )
        )
        builder.setCategory(NotificationCompat.CATEGORY_MESSAGE)
    }
}
