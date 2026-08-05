// @ts-check
/**
 * What the linter is for here.
 *
 * TypeScript already checks types and the tests already check behaviour, so a
 * linter that also argues about quote marks and line length is pure noise — and
 * a noisy linter gets `--no-verify`'d within a week. So this config carries
 * almost no style rules. What it does carry are the rules that need the type
 * checker to work at all, because those catch a class of bug nothing else here
 * can see:
 *
 *   - a promise nobody awaited, in a daemon that is mostly sockets and spawned
 *     processes, where the symptom is an operation that silently never happens
 *   - an async function handed to something expecting a sync callback, where
 *     the rejection goes nowhere
 *   - an `await` on a value that was never a promise
 *   - a switch that stopped being exhaustive when someone added a variant
 *
 * A lot is switched off below, and every one of those says why. That matters
 * more than the list of what is on: a rule disabled without a reason is how a
 * config stops being trustworthy.
 *
 * Formatting is deliberately not linted. If that ever matters, it is a
 * formatter's job, not this file's.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Nothing generated, vendored, or built. `.expo` and `ios` in particular
    // hold thousands of files nobody in this repo wrote.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "packages/app/.expo/**",
      "packages/app/ios/**",
      "packages/app/android/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Resolves each file against whichever of the four tsconfigs actually
        // owns it — root, relay, or app — instead of maintaining a parallel
        // list here that would drift the first time one of them moves.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── the reason this file exists ────────────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        // A `switch` over a value that can be undefined does not need an
        // `undefined` case when it already has a `default`.
        { considerDefaultExhaustiveForUnions: true },
      ],

      // ── off, each for a reason ─────────────────────────────────────────
      // The unsafe-`any` family, ~480 hits. Nearly all of them are one thing:
      // JSON arriving off a socket, which is genuinely `any` until the schema
      // check on the next line makes it real. The rule cannot see that the
      // check is there, so its advice is to write `as Foo` instead — swapping
      // an honest `any` for an unchecked lie. The wire tests are what actually
      // guard this boundary.
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // Fires on every `async` method that satisfies an interface but happens
      // not to await — Workers' `fetch`, ACP handlers. The signature is fixed
      // by the caller, so this is asking for a change that cannot be made.
      "@typescript-eslint/require-await": "off",

      // Both of these are correct only if the declared types are the whole
      // truth. Here they are not: values cross a socket and a subprocess
      // boundary, and the defensive check the rule calls redundant is the one
      // that catches a peer sending something the types promised it would not.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Equally: `packages/app` does not set `noUncheckedIndexedAccess` while
      // the root project does, so the same `arr[i]!` is "unnecessary" in one
      // half of the repo and required in the other. Deleting them would break
      // the moment the app's config catches up.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",

      // An unused variable is usually a half-finished edit. Leading underscore
      // is the escape hatch, for the arguments you must accept but not use.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",

      // This repo is a CLI and a daemon. Printing to stdout is the product,
      // and logging is how the daemon is debugged in the field.
      "no-console": "off",

      // Half the CLI's job is emitting and stripping ANSI, so `\x1b` in a
      // regex is the subject matter rather than a typo — `stripAnsi` cannot be
      // written without it.
      "no-control-regex": "off",

      // Every `any` in this repo is the same thing: a payload that just came
      // off a socket or out of an agent's stdout, which is genuinely untyped
      // until the schema check on the next line. Started as an allowlist of
      // the files that parse wire data and it was already eight entries and
      // growing, which is a list that rots rather than a rule. The unsafe-`any`
      // family above is off for the same reason, so this was not buying much.
      "@typescript-eslint/no-explicit-any": "off",

      // Numbers and booleans in template strings are intentional throughout
      // the rendering code (`${count} agents`), and stringifying them is the
      // correct behaviour, not an accident.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    files: ["packages/app/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // A stale dependency array is a real bug — it shows up as "the screen
      // just does not update sometimes". But the fix is never mechanical:
      // adding a dep can turn a one-shot effect into a render loop, and the
      // only way to know is to run the app. So these are visible and do not
      // block, which is the honest state of them.
      "react-hooks/exhaustive-deps": "warn",

      // Resetting state when the thing being displayed changes — clearing a
      // failed image when the source changes, dropping a sheet's step when it
      // reopens — is exactly this pattern, and it is correct. Several of these
      // sites are deliberate fixes for real bugs (Sheet's mount gate exists to
      // stop an invisible full-screen scrim eating touches). A perf heuristic
      // should not argue those back out.
      "react-hooks/set-state-in-effect": "off",

      // Animated values and layout measurements are held in refs and touched
      // during render on purpose throughout this app; ~150 hits, no bugs.
      "react-hooks/refs": "off",
    },
  },

  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.harness.tsx",
      // Fixtures: a fake ACP agent and the pipeline harness that drives it.
      "packages/daemon/src/testing/**",
    ],
    rules: {
      // Tests thread state through a sequence of steps, so the last step's
      // assignment is legitimately never read. In production code this rule
      // finds dead stores worth deleting; here it just asks for an uglier test.
      //
      // This is the only rule tests need relaxed. `any`, the unsafe-* family
      // and `no-unnecessary-condition` are all off repo-wide already, and
      // `no-non-null-assertion` ships in `strictTypeChecked` rather than the
      // `recommendedTypeChecked` this config extends — so it was never on to
      // turn off, and saying otherwise here claimed a protection that did not
      // exist.
      "no-useless-assignment": "off",
    },
  },

  {
    // Config and script files are not part of any tsconfig's `include`, so
    // there are no types to lint them against.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Explicitly off, not just absent: the type-aware block above already
      // turned the project service on for every file, and leaving it on here
      // makes these fail to parse at all rather than lint without types.
      parserOptions: { projectService: false, project: false },
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        WebSocket: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        // Expo's config files are CommonJS.
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
      },
    },
    rules: {
      // Spread first: `disableTypeChecked` carries its own `rules` block, and a
      // bare `rules:` key here would replace it wholesale rather than add to
      // it — leaving the type-aware rules on for files that have no types.
      ...tseslint.configs.disableTypeChecked.rules,
      // `metro.config.js` and `babel.config.js` are loaded by tooling that
      // predates ESM here; `require` is the only thing that works in them.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  {
    // Bun's `expect(...).resolves` is not typed as a thenable, so awaiting it
    // — which is what the docs tell you to do — reads as awaiting a plain
    // value. Every hit is in a test and every one of them is correct.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/await-thenable": "off" },
  },
);
