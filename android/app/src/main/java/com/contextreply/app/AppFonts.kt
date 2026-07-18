package com.contextreply.app

import android.content.Context
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat

/**
 * Kotlin counterpart to src/theme.ts's FONTS — same IBM Plex Sans/Mono weights,
 * loaded from res/font/ instead of npm packages since the bubble is built
 * programmatically (no XML layouts, no Expo font-loading available here).
 * Cached per-weight after first use — ResourcesCompat.getFont() itself already
 * caches internally, but avoiding the repeated call keeps bubble construction
 * (called on every new suggestion) cheap.
 */
object AppFonts {
    private val cache = HashMap<Int, Typeface>()

    private fun get(context: Context, resId: Int): Typeface {
        cache[resId]?.let { return it }
        val tf = ResourcesCompat.getFont(context, resId) ?: Typeface.DEFAULT
        cache[resId] = tf
        return tf
    }

    fun regular(context: Context): Typeface   = get(context, R.font.ibm_plex_sans_regular)
    fun medium(context: Context): Typeface    = get(context, R.font.ibm_plex_sans_medium)
    fun semibold(context: Context): Typeface  = get(context, R.font.ibm_plex_sans_semibold)
    fun bold(context: Context): Typeface      = get(context, R.font.ibm_plex_sans_bold)
    fun mono(context: Context): Typeface      = get(context, R.font.ibm_plex_mono_medium)
    fun monoSemibold(context: Context): Typeface = get(context, R.font.ibm_plex_mono_semibold)
}
