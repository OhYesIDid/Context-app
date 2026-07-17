if (!__DEV__) {
  console.log = () => {};
  console.warn = () => {};
}

import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import App from './App';
import { COLORS, FONTS, FONTS_TO_LOAD } from './src/theme';

// App-wide default typeface — applied once here rather than adding
// fontFamily to every individual Text usage across every screen.
// eslint-disable-next-line no-underscore-dangle
if (Text.defaultProps == null) Text.defaultProps = {};
Text.defaultProps.style = [{ fontFamily: FONTS.regular }, Text.defaultProps.style];

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <View style={s.container}>
          <Text style={s.title}>Crash report</Text>
          <ScrollView>
            <Text style={s.body} selectable>
              {this.state.error?.toString?.() ?? 'Unknown error'}
              {'\n\n'}
              {this.state.error?.stack ?? ''}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return React.createElement(App);
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0c0e', padding: 24, paddingTop: 60 },
  title: { color: '#f87171', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  body: { color: '#f4f4f5', fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
});

// Loads the app typeface before ErrorBoundary/App ever mount, rather than
// inside App itself — App.tsx has a large, fixed sequence of hooks, and an
// early return there for a "still loading" state would change how many
// hooks run between renders and break the rules of hooks.
function Root() {
  const [fontsLoaded] = useFonts(FONTS_TO_LOAD);
  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: COLORS.bg }} />;
  }
  return <ErrorBoundary />;
}

registerRootComponent(Root);
