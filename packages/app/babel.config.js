/**
 * Reanimated's worklet plugin, required by react-native-keyboard-controller.
 *
 * Keyboard-driven layout runs on the UI thread, and the functions that do it
 * must be compiled into worklets. Without this plugin they stay ordinary JS and
 * every keyboard animation silently falls back to the JS thread.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};
