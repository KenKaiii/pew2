/**
 * Metro, taught that this app lives in a workspace.
 *
 * Dependencies are hoisted to the repo root, so Metro must watch that root and
 * resolve through both `node_modules` folders. Without this an installed package
 * still fails with "Unable to resolve module".
 */
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
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName.replace(/\.js$/, ""), platform);
    } catch {
      // Not a TypeScript source after all — fall through to the real file.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
