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

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
