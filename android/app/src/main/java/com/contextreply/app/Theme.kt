package com.contextreply.app

import android.graphics.Color

// Kotlin counterpart to src/theme.ts — same "Instrument" token values, kept
// in one place instead of duplicated as local vals inside the Activity that
// uses them. See src/theme.ts for the rationale and the CONTEXT (teal) note.
object Theme {
    val BG        = Color.parseColor("#14171c")
    val SURFACE   = Color.parseColor("#1b1f26")
    val SURFACE2  = Color.parseColor("#23272f")
    val BORDER    = Color.parseColor("#2a2f37")
    val TEXT      = Color.parseColor("#eef1f3")
    val MUTED     = Color.parseColor("#9aa3ad")

    val SIGNAL     = Color.parseColor("#e2933c")  // primary accent — was PURPLE #6366f1
    val SIGNAL_BG  = Color.parseColor("#e2933c22")
    val CONTEXT    = Color.parseColor("#2f8f8a")  // secondary accent — calendar/location/trip signals
    val CONTEXT_BG = Color.parseColor("#2f8f8a22")

    val GREEN    = Color.parseColor("#22c55e")
    val GREEN_BG = Color.parseColor("#22c55e22")
}
