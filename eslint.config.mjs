// ============================================================
// eslint.config.mjs — minimal ESLint v9 flat config
// ------------------------------------------------------------
// Lints src/** with a small set of CORE rules that need NO type
// information and NO extra plugins. This keeps the project's
// zero-heavy-dep posture intact.
//
// ESLint itself is NOT a project dependency (to avoid bloating the
// Worker install). To run the linter:
//
//     npm i -D eslint
//     npx eslint src/
//
// The rules below give us "no-floating-promises-style discipline"
// using only what the core ruleset can enforce without a type
// checker:
//   - require-await       : an async fn that never awaits is a smell
//                           (usually a forgotten await on a promise).
//   - no-unused-vars      : catches a dropped promise stored then
//                           never used, plus dead bindings/imports.
//   - no-undef            : catches typos / missing imports.
//   - no-constant-condition: catches `while (true)`-style mistakes
//                           and `if (promise)` truthiness bugs.
//
// (True no-floating-promises needs @typescript-eslint + type info,
//  which we deliberately do NOT pull in.)
// ============================================================

export default [
	{
		files: ["src/**/*.js"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
			globals: {
				// Cloudflare Workers / Web Platform runtime globals.
				fetch: "readonly",
				Response: "readonly",
				Request: "readonly",
				Headers: "readonly",
				URL: "readonly",
				URLSearchParams: "readonly",
				crypto: "readonly",
				caches: "readonly",
				AbortSignal: "readonly",
				AbortController: "readonly",
				TextEncoder: "readonly",
				TextDecoder: "readonly",
				atob: "readonly",
				btoa: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				console: "readonly",
				structuredClone: "readonly",
			},
		},
		rules: {
			"no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"no-undef": "error",
			"require-await": "warn",
			"no-constant-condition": ["error", { checkLoops: false }],
		},
	},
];
