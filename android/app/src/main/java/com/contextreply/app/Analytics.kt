package com.contextreply.app

import android.content.Context
import android.os.Bundle
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics

// Thin wrapper around Firebase Analytics — usage/engagement signal only,
// deliberately separate from FirebaseCrashlytics (crash/error reporting).
// Fire-and-forget: a logging failure is itself reported to Crashlytics for
// visibility, but never allowed to propagate to the caller.
object Analytics {
    fun log(context: Context, name: String, params: Map<String, String> = emptyMap()) {
        try {
            val bundle = Bundle()
            params.forEach { (k, v) -> bundle.putString(k, v) }
            FirebaseAnalytics.getInstance(context).logEvent(name, bundle)
        } catch (e: Exception) {
            FirebaseCrashlytics.getInstance().recordException(e)
        }
    }
}
