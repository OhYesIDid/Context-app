package com.contextreply.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import java.io.File
import java.io.FileOutputStream

/**
 * Attaches BubbleMetadata + MessagingStyle to an existing notification builder.
 * Everything bubble-related is contained here.
 * To remove bubbles entirely: delete this file, delete BubbleSuggestionActivity.kt,
 * remove the BubbleHelper.attach() call from ProTxtBgService, and remove
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
        message: String = "",
        detectedIntents: String = "",
        preferredTone: String? = null,
        actionJson: String? = null,
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
            putExtra(ProTxtBgService.EXTRA_REPLY_TEXT, replyText)
            putExtra(ProTxtBgService.EXTRA_REPLY_FORMAL, formalText ?: "")
            putExtra(ProTxtBgService.EXTRA_REPLY_BRIEF, briefText ?: "")
            putExtra(ProTxtBgService.EXTRA_REMOTE_INPUT_KEY, remoteInputKey)
            putExtra(ProTxtBgService.EXTRA_NOTIF_ID, notifId)
            putExtra(ProTxtBgService.EXTRA_CONV_KEY, convKey)
            if (intentExtra != null) putExtra(ProTxtBgService.EXTRA_INTENT, intentExtra)
            if (openChatIntent != null) putExtra(ProTxtBgService.EXTRA_OPEN_CHAT_INTENT, openChatIntent)
            if (message.isNotEmpty()) putExtra(ProTxtBgService.EXTRA_MESSAGE, message)
            if (detectedIntents.isNotEmpty()) putExtra(ProTxtBgService.EXTRA_INTENTS, detectedIntents)
            if (preferredTone != null) putExtra(ProTxtBgService.EXTRA_PREFERRED_TONE, preferredTone)
            if (actionJson != null) putExtra(ProTxtBgService.EXTRA_ACTION_JSON, actionJson)
        }
        val bubblePi = PendingIntent.getActivity(
            context, notifId + 2, bubbleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        builder.setShortcutId(shortcutId)
        builder.setBubbleMetadata(
            NotificationCompat.BubbleMetadata.Builder(
                bubblePi,
                bubbleIcon(context)
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

    // Android 12+ (API 31) requires bubble icons to be TYPE_URI or TYPE_URI_ADAPTIVE_BITMAP;
    // resource icons are silently ignored and the notification falls back to heads-up.
    private fun bubbleIcon(context: Context): IconCompat {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
        return try {
            val iconFile = File(context.cacheDir, "cr_bubble_icon.png")
            if (!iconFile.exists() || iconFile.length() == 0L) {
                val drawable = context.packageManager.getApplicationIcon(context.packageName)
                val bm = (drawable as? BitmapDrawable)?.bitmap
                    ?: Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
                FileOutputStream(iconFile).use { bm.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            val uri = FileProvider.getUriForFile(
                context, "${context.packageName}.fileprovider", iconFile
            )
            IconCompat.createWithAdaptiveBitmapContentUri(uri)
        } catch (_: Exception) {
            IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
    }
}
