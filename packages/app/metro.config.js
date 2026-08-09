/**
 * Metro, taught that this app lives in a workspace.
 *
 * Dependencies are hoisted to the repo root, so Metro must watch that root and
 * resolve through both `node_modules` folders. Without this an installed package
 * still fails with "Unable to resolve module".
 */
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Resolve each package once. Two copies of React or Reanimated in one bundle is
// a hook-order crash, not a slow build.
config.resolver.disableHierarchicalLookup = true;

/**
 * Evaluate each module the first time it is actually used, not at startup.
 *
 * Metro's default hoists every `import` to the top of the module that declares
 * it, so launching the app evaluated the entire reachable graph before the
 * first frame — the camera, the image and media pickers, speech recognition,
 * the notification stack, the markdown renderer — whether or not this session
 * ever opens any of them. Inlining rewrites those into `require` calls at the
 * point of use, so a screen nobody visits costs nothing to launch past.
 *
 * React Native's own metro-config ships this on; Expo leaves it off for
 * compatibility with modules that depend on import side effects at load time.
 * The one such module here is the crypto polyfill, which must install before
 * anything asks for `crypto.getRandomValues`. It is a bare `import` for its
 * side effect only and binds no names, so there is no reference for Metro to
 * inline against and its position is preserved either way.
 */
config.transformer.getTransformOptions = async () => ({
  transform: {
    // Expo's own default, restated because replacing `getTransformOptions`
    // replaces the whole object rather than merging into it. Dropping it here
    // would quietly turn Metro's ESM handling back off.
    experimentalImportSupport: true,
    inlineRequires: true,
  },
});

/**
 * Let the app import the shared protocol package.
 *
 * `@pew2/protocol` is TypeScript compiled under NodeNext, where a relative
 * import must carry a `.js` suffix even though the file on disk is `.ts`. Metro
 * takes that suffix literally, looks for a `.js` that was never emitted, and
 * fails the bundle — so the two toolchains disagree about the same correct
 * source, and only at bundle time.
 *
 * Mapping the suffix back is the narrow fix. The alternatives are worse: making
 * the app depend on a build step reintroduces a stale-artifact class of bug, and
 * hand-copying constants across the boundary is what the encryption code must
 * never do — the phone and the daemon have to agree on the key schedule exactly,
 * and a duplicated implementation that drifts would fail as traffic that cannot
 * be decrypted rather than as a type error.
 */
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolve ?? context.resolveRequest;
  const harness = harnessFor(moduleName);
  if (harness) return resolve(context, harness, platform);
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName.replace(/\.js$/, ""), platform);
    } catch {
      // Not a TypeScript source after all — fall through to the real file.
    }
  }
  return resolve(context, moduleName, platform);
};

/**
 * Swap the app for a component harness when one is asked for.
 *
 * The app shows nothing but a pairing screen until it has a paired daemon, and
 * pairing is camera-only by design — which a simulator has no way to do. That
 * left every question about the composer answerable only by building an `.ipa`
 * and typing on a real phone: three rounds of that went into finding one stray
 * re-render, and the first two fixes were aimed at the wrong layer because
 * nothing here could render the component and watch how it behaved.
 *
 * `bun run harness` opens the simulator straight into one, with no pairing, no
 * daemon and no network. Metro rewrites the entry's `./App` import, so nothing
 * in the app's own source knows harnesses exist and a production bundle cannot
 * contain one however the flag is set at runtime.
 *
 * Returns undefined for every other module, and for every build that did not
 * ask, leaving the resolve above untouched.
 */
function harnessFor(moduleName) {
  const name = process.env.EXPO_PUBLIC_HARNESS;
  if (!name || moduleName !== "./App") return undefined;
  if (!fs.existsSync(path.join(projectRoot, "src/ui", `${name}.harness.tsx`))) {
    // Fail the bundle rather than the render. A typo would otherwise start the
    // app normally, onto the pairing screen, looking exactly like a harness
    // that rendered nothing.
    throw new Error(`No harness "${name}". Expected src/ui/${name}.harness.tsx`);
  }
  return `./src/ui/${name}.harness`;
}

module.exports = config;
