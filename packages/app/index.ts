/**
 * App entry point.
 *
 * The crypto polyfill is first, and before every other import: the encryption
 * layer needs `crypto.getRandomValues`, Hermes has no Web Crypto at all, and
 * without it the app builds and launches and then throws the first time it seals
 * a frame — which is the moment someone scans a pairing code.
 */
import "./src/cryptoPolyfill";

import { registerRootComponent } from 'expo';

import { installCrashHandler } from './src/crashLog';
import App from './App';

// Before anything renders, so a crash during startup is still recorded. Startup
// is where the unexplained ones happen — a native module missing, a stored value
// that no longer parses — and it is the one window `ErrorBoundary` cannot cover,
// because nothing is mounted yet to catch anything.
installCrashHandler();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
