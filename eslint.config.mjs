// Monorepo ESLint config — one flat config covering apps/admin, apps/storefront
// and packages/shared.
//
// WHY THIS EXISTS
// ---------------
// There was no ESLint config in this repo at all. Both apps had a
// `"lint": "next lint"` script, but with no config behind it that script has
// always been a silent no-op — which is why source files already carry
// `// eslint-disable-next-line react-hooks/exhaustive-deps` comments for a rule
// that had never once run.
//
// The cost of that showed up in production: <PaymentSheet> called a hook after
// an early return, so a closed sheet ran six hooks and an open one ran seven,
// and pressing "Charge" threw "Rendered more hooks than during the previous
// render" straight into the route error boundary. Neither TypeScript nor
// `next build` can see hook ordering. `react-hooks/rules-of-hooks` catches it in
// one line, so it is set to ERROR and wired into the pre-build step: a violation
// now fails the build instead of reaching a till.
//
// `next lint` is deprecated in Next 15.5 and removed in 16, so the lint scripts
// call the ESLint CLI directly rather than going through Next.

import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",          // production build output (NEXT_DIST_DIR=out)
      "**/dist/**",
      "**/.vercel/**",
      "**/.wrangler/**",
      "**/*.d.ts",
      "supabase/**",
      "scripts/**",
    ],
  },
  {
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      // Deliberately NOT type-aware: the Rules of Hooks are purely syntactic, and
      // a type-aware program would make linting as slow as a full typecheck (which
      // `npm run typecheck` already does separately).
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    // @typescript-eslint and @next/next are REGISTERED but their rules are left
    // off. The codebase already carries `eslint-disable-next-line` comments for
    // `@next/next/no-img-element` and `@typescript-eslint/no-explicit-any`, and
    // ESLint 9 raises a hard error for a disable comment naming a rule it does
    // not know about. Registering the plugins makes those existing comments
    // resolve; deliberately enabling no rules from them keeps this change purely
    // about the Rules of Hooks rather than quietly opening a second front of
    // unrelated lint failures. Turn individual rules on later if you want them.
    linterOptions: {
      // The @next/next and @typescript-eslint rules above are registered but
      // OFF, so every existing `eslint-disable` comment naming one of them is
      // inert by design — reporting 14 of those as "unused" on every run is the
      // kind of noise that teaches people to ignore lint output, which is how
      // the Rules-of-Hooks gap survived this long. Turn this back on if those
      // rules are ever enabled.
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tsPlugin,
      "@next/next": nextPlugin,
    },
    rules: {
      // The guardrail. ERROR so it fails `npm run build`, never a warning that
      // scrolls past unnoticed.
      "react-hooks/rules-of-hooks": "error",

      // Genuinely useful, but it flags a body of pre-existing intentional code
      // (see the existing eslint-disable comments). Left at "warn" so it is
      // visible without blocking a deploy — raise to "error" once the backlog
      // below is worked through.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
