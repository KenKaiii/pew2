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

module.exports = config;
