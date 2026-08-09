/**
 * Reanimated's worklet plugin, required by react-native-keyboard-controller.
 *
 * Keyboard-driven layout runs on the UI thread, and the functions that do it
 * must be compiled into worklets. Without this plugin they stay ordinary JS and
 * every keyboard animation silently falls back to the JS thread.
 *
 * Plus the React Compiler, deliberately narrowed — see `sources` below.
 */

/**
 * Which files the React Compiler is allowed to memoise.
 *
 * `experiments.reactCompiler` in app.json turns it on; this decides where. It
 * is the screens and controls only, and that is a considered limit rather than
 * caution for its own sake.
 *
 * The compiler's correctness rests on the rules of React, and this app breaks
 * one of them on purpose in a way `eslint.config.js` documents: refs are read
 * during render. Every such site but one is `useRef(new Animated.Value(…))` — a
 * stable box whose identity never changes, so memoising around it cannot change
 * what renders. That idiom is safe here; a *derived* ref would not have been,
 * which is why the one that existed was rewritten as lazy state instead.
 *
 * What stays out is the part where being wrong is expensive and invisible:
 * `useDaemon.ts` holds the socket, the sequence cursors and the transcript fold,
 * and a dropped update there does not look like a slow screen — it looks like a
 * reply that never arrived. That code is not what the user feels as jank, so it
 * has nothing to gain and a bad failure mode. Widen this only after the UI has
 * been through a real session on a device.
 *
 * Of the 33 components in scope, 25 are memoised and 8 are left exactly as
 * written. That split is not arbitrary and is worth knowing before reading a
 * profile: the compiler refuses any component that assigns to a Reanimated
 * shared value from a callback — `Composer`, `ComposerDock`, `ShimmerText`,
 * `ActivityLine`, `TurnReceipt`, `ThoughtSheet`, `ConfigPicker` — because it
 * cannot prove that write is safe, and `ErrorBoundary` because it is a class.
 * Those are the files whose hand-written memoisation is load-bearing rather
 * than belt-and-braces, so do not strip it out of them.
 *
 * The refusal is a silent skip, not an error: `panicThreshold` is `NONE` in
 * release builds, so a file the compiler cannot handle keeps its original code
 * and the build succeeds. That is the reason this is safe to leave on, and also
 * the reason a component can quietly stop being optimised when someone adds a
 * shared-value write to it. The bail-out is only visible if you go looking.
 */
const COMPILED = "/packages/app/src/ui/";

module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [
      [
        "babel-preset-expo",
        {
          "react-compiler": {
            // Absolute paths, so this matches the same way regardless of where
            // Metro is invoked from — this is a monorepo and the app is not the
            // working directory.
            sources: (filename) => filename.replaceAll("\\", "/").includes(COMPILED),
          },
        },
      ],
    ],
    plugins: ["react-native-worklets/plugin"],
  };
};
