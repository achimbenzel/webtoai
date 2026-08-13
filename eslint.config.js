import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // ExtendScript host code is ES3 and is linted by its own config below.
      "apps/cep-extension/host/lib/json2.js",
      "fixtures/**/expected-scene.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  {
    // ExtendScript: ES3 only. This config is the machine-checked half of the
    // "no ES5+ syntax" rule from docs/ARCHITECTURE.md.
    files: ["apps/cep-extension/host/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 3,
      sourceType: "script",
      globals: {
        $: "readonly",
        app: "readonly",
        File: "readonly",
        Folder: "readonly",
        JSON: "readonly",
        ExternalObject: "readonly",
        DocumentColorSpace: "readonly",
        UserInteractionLevel: "readonly",
        ElementPlacement: "readonly",
        TextType: "readonly",
        Justification: "readonly",
        StrokeCap: "readonly",
        StrokeJoin: "readonly",
        GradientType: "readonly",
        RGBColor: "readonly",
        GrayColor: "readonly",
        NoColor: "readonly",
        GradientColor: "readonly",
        CMYKColor: "readonly",
        Matrix: "readonly",
        BlendModes: "readonly",
        web2ai: "writable",
      },
    },
    rules: {
      "no-var": "off",
      "prefer-const": "off",
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      // The base rule above is the configured one; the TypeScript variant has
      // different defaults and this is not TypeScript.
      "@typescript-eslint/no-unused-vars": "off",
      // ExtendScript ends a regex literal at the first unescaped "/", even
      // inside a character class, so `/[\\\/]+$/` needs an escape that modern
      // JavaScript considers useless. Obeying this rule here produced a syntax
      // error that took down the entire host bundle.
      // apps/cep-extension/scripts/es3-checks.mjs enforces the opposite.
      "no-useless-escape": "off",
    },
  },
  {
    // Build and install scripts run under plain Node.
    files: ["**/*.mjs", "**/*.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-console": "off" },
  },
  {
    // Runs under Node but ships closures into a browser page via
    // page.evaluate(), so it legitimately references DOM globals.
    files: ["scripts/capture-fixtures.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
