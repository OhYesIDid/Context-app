// Single source of truth for color and type tokens — "Instrument" design
// direction. Previously these were duplicated verbatim (same hex literals,
// same const names) across App.tsx, every screen, and BubbleSuggestionActivity.kt
// independently; a design-token change meant hunting down every copy.
//
// Scope note: this pass is a mechanical token swap (color values + base
// typeface), not a semantic redesign. CONTEXT (teal) exists here for future
// use on calendar/location/trip-specific UI but isn't force-applied to
// existing call sites yet — that's a deliberate follow-up, not an oversight.

export const COLORS = {
  bg: '#14171c',
  bg2: '#1b1f26',
  bg3: '#23272f',
  border: 'rgba(232, 238, 242, 0.12)',
  text: '#eef1f3',
  muted: '#9aa3ad',

  signal: '#e2933c',   // primary accent — urgency / action / CTAs (was PURPLE #6366f1)
  context: '#2f8f8a',  // secondary accent — calendar / location / trip signals (new, not yet applied)

  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
} as const;

export const FONTS = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  bold: 'IBMPlexSans_700Bold',
  mono: 'IBMPlexMono_500Medium',
  monoSemibold: 'IBMPlexMono_600SemiBold',
} as const;

export const FONTS_TO_LOAD = {
  IBMPlexSans_400Regular: require('@expo-google-fonts/ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf'),
  IBMPlexSans_500Medium: require('@expo-google-fonts/ibm-plex-sans/500Medium/IBMPlexSans_500Medium.ttf'),
  IBMPlexSans_600SemiBold: require('@expo-google-fonts/ibm-plex-sans/600SemiBold/IBMPlexSans_600SemiBold.ttf'),
  IBMPlexSans_700Bold: require('@expo-google-fonts/ibm-plex-sans/700Bold/IBMPlexSans_700Bold.ttf'),
  IBMPlexMono_500Medium: require('@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf'),
  IBMPlexMono_600SemiBold: require('@expo-google-fonts/ibm-plex-mono/600SemiBold/IBMPlexMono_600SemiBold.ttf'),
};

// Legacy aliases — lets existing screens swap their local consts for these
// without renaming every usage in the same pass. New code should prefer
// COLORS.* directly.
export const PURPLE = COLORS.signal;
export const BG = COLORS.bg;
export const SURFACE = COLORS.bg2;
export const BORDER = COLORS.border;
export const TEXT = COLORS.text;
export const MUTED = COLORS.muted;
export const GREEN = COLORS.success;
export const AMBER = COLORS.warning;
export const RED = COLORS.danger;
