package com.contextreply.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Only the two staleness thresholds are pure/testable here — everything else in
// LocationTracker is a thin LocationManager/Geocoder wrapper with no decision logic of its
// own. Deliberately keeping the two checks' operators distinct (<= vs <), matching the
// original inline code exactly rather than unifying them into one shared helper.
class LocationTrackerTest {

    @Test fun `continuous fix is fresh at exactly the 2-minute boundary (inclusive)`() {
        val now = 1_000_000L
        assertTrue(LocationTracker.isContinuousFixFresh(fixTimeMs = now - 120_000L, nowMs = now))
    }

    @Test fun `continuous fix is stale just past the 2-minute boundary`() {
        val now = 1_000_000L
        assertFalse(LocationTracker.isContinuousFixFresh(fixTimeMs = now - 120_001L, nowMs = now))
    }

    @Test fun `continuous fix well within the window is fresh`() {
        val now = 1_000_000L
        assertTrue(LocationTracker.isContinuousFixFresh(fixTimeMs = now - 1_000L, nowMs = now))
    }

    @Test fun `cached fix is fresh enough just under the 30s boundary`() {
        val now = 1_000_000L
        assertTrue(LocationTracker.isCachedFixFreshEnough(fixTimeMs = now - 29_999L, nowMs = now))
    }

    @Test fun `cached fix is NOT fresh enough at exactly the 30s boundary (exclusive)`() {
        val now = 1_000_000L
        assertFalse(LocationTracker.isCachedFixFreshEnough(fixTimeMs = now - 30_000L, nowMs = now))
    }

    @Test fun `cached fix well past the window is not fresh enough`() {
        val now = 1_000_000L
        assertFalse(LocationTracker.isCachedFixFreshEnough(fixTimeMs = now - 60_000L, nowMs = now))
    }
}
