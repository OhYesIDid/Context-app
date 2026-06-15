package com.contextreply.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
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
        contactMatchJson: String? = null,
        suggestionTs: Long = 0L,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return

        val contact = convKey.substringAfter(":")
        // _v6: contact initial circle → shortcut icon → main bubble dot; app logo → BubbleMetadata badge
        val shortcutId = "cr_conv_v5_${convKey.hashCode().and(0x7FFFFFFF)}"
        val contactIcon = contactIcon(context, contact)
        val person = Person.Builder().setName(contact).setIcon(contactIcon).build()
        try {
            val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
                .setLongLived(true)
                .setIntent(
                    Intent(context, BubbleSuggestionActivity::class.java)
                        .setAction(Intent.ACTION_VIEW)
                )
                .setShortLabel(contact.take(25))
                .setPerson(person)
                .setIcon(contactIcon)
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
            if (contactMatchJson != null) putExtra(ProTxtBgService.EXTRA_CONTACT_MATCH_JSON, contactMatchJson)
            if (suggestionTs > 0L) putExtra(ProTxtBgService.EXTRA_SUGGESTION_TS, suggestionTs)
        }
        val bubblePi = PendingIntent.getActivity(
            context, notifId + 2, bubbleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        builder.setShortcutId(shortcutId)
        builder.setBubbleMetadata(
            NotificationCompat.BubbleMetadata.Builder(
                bubblePi,
                appIcon(context)
            )
            .setDesiredHeight(520)
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

    // App logo served via FileProvider — used as the main bubble dot on Android 12+.
    private fun iconDir(context: Context): File =
        File(context.cacheDir, "bubble_icons").also { it.mkdirs() }

    private fun appIcon(context: Context): IconCompat {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
        return try {
            val iconFile = File(iconDir(context), "cr_app_bubble.png")
            if (!iconFile.exists() || iconFile.length() == 0L) {
                val size = (108 * context.resources.displayMetrics.density).toInt()
                // getApplicationIcon works for any drawable type including AdaptiveIconDrawable
                val drawable = context.packageManager.getApplicationIcon(context.packageName)
                val bm = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bm)
                drawable.setBounds(0, 0, size, size)
                drawable.draw(canvas)
                FileOutputStream(iconFile).use { bm.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bm.recycle()
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", iconFile)
            IconCompat.createWithAdaptiveBitmapContentUri(uri)
        } catch (e: Exception) {
            android.util.Log.e("BubbleHelper", "appIcon failed: ${e.javaClass.simpleName}: ${e.message}")
            IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
    }

    // ConTxt logo background + contact initial overlay — used as the main bubble dot.
    // OPPO always overrides the badge position with the app launcher icon regardless of what we pass,
    // so we combine both signals into one composite icon in the main dot.
    private fun compositeIcon(context: Context, contact: String): IconCompat {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
        return try {
            val size = (108 * context.resources.displayMetrics.density).toInt()
            val initial = contact.firstOrNull()?.uppercase() ?: "?"
            val iconFile = File(iconDir(context), "cr_composite_${contact.hashCode().and(0x7FFFFFFF)}_$size.png")
            if (!iconFile.exists() || iconFile.length() == 0L) {
                val drawable = context.packageManager.getApplicationIcon(context.packageName)
                val bm = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bm)
                drawable.setBounds(0, 0, size, size)
                drawable.draw(canvas)
                // Semi-transparent dark circle so the initial is readable over any logo colour
                val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(170, 0, 0, 0)
                }
                val r = size * 0.30f
                canvas.drawCircle(size / 2f, size / 2f, r, circlePaint)
                val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.WHITE
                    textSize = size * 0.30f
                    typeface = Typeface.DEFAULT_BOLD
                    textAlign = Paint.Align.CENTER
                }
                val yOff = (textPaint.descent() + textPaint.ascent()) / 2
                canvas.drawText(initial, size / 2f, size / 2f - yOff, textPaint)
                FileOutputStream(iconFile).use { bm.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bm.recycle()
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", iconFile)
            IconCompat.createWithAdaptiveBitmapContentUri(uri)
        } catch (e: Exception) {
            android.util.Log.e("BubbleHelper", "compositeIcon failed: ${e.javaClass.simpleName}: ${e.message}")
            IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
    }

    // Per-contact coloured circle with initial — kept for reference; no longer used as main dot.
    private fun contactIcon(context: Context, contact: String): IconCompat {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
        return try {
            // 108dp at the device's actual pixel density matches the adaptive-icon spec.
            // Include size in the filename so stale files from the wrong density are ignored.
            val size = (108 * context.resources.displayMetrics.density).toInt()
            val iconFile = File(iconDir(context), "cr_icon_${contact.hashCode().and(0x7FFFFFFF)}_$size.png")
            if (!iconFile.exists() || iconFile.length() == 0L) {
                val bm = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bm)
                val palette = listOf(0xFF6366f1L, 0xFF8b5cf6L, 0xFFec4899L, 0xFFf43f5eL,
                                     0xFFf59e0bL, 0xFF10b981L, 0xFF06b6d4L, 0xFF3b82f6L)
                val bgColor = palette[contact.hashCode().and(0x7FFFFFFF) % palette.size].toInt()
                val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = bgColor }
                canvas.drawOval(RectF(0f, 0f, size.toFloat(), size.toFloat()), bgPaint)
                val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.WHITE
                    textSize = size * 0.42f
                    typeface = Typeface.DEFAULT_BOLD
                    textAlign = Paint.Align.CENTER
                }
                val initial = contact.firstOrNull()?.uppercase() ?: "?"
                val yOff = (textPaint.descent() + textPaint.ascent()) / 2
                canvas.drawText(initial, size / 2f, size / 2f - yOff, textPaint)
                FileOutputStream(iconFile).use { bm.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bm.recycle()
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", iconFile)
            IconCompat.createWithAdaptiveBitmapContentUri(uri)
        } catch (e: Exception) {
            android.util.Log.e("BubbleHelper", "contactIcon failed: ${e.javaClass.simpleName}: ${e.message}")
            IconCompat.createWithResource(context, R.mipmap.ic_launcher_round)
        }
    }
}
