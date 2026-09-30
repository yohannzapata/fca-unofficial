// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Module boundaries (docs/architecture.md §2): lower layers must not import upper ones.
 * Each entry: files in `from` may not import modules matching `forbid`.
 */
const boundaries = [
  {
    from: "src/transport/**",
    forbid: ["**/protocol/**", "**/pipeline/**", "**/services/**", "**/client/**"],
  },
  { from: "src/protocol/**", forbid: ["**/pipeline/**", "**/services/**", "**/client/**"] },
  { from: "src/pipeline/**", forbid: ["**/transport/**", "**/services/**", "**/client/**"] },
  { from: "src/services/**", forbid: ["**/transport/**", "**/client/**"] },
  {
    from: "src/lifecycle/**",
    forbid: ["**/transport/**", "**/protocol/**", "**/services/**", "**/client/**"],
  },
  { from: "src/session/**", forbid: ["**/transport/**", "**/protocol/**", "**/services/**", "**/client/**"] },
  {
    from: "src/{errors,logging,events,util,model}/**",
    forbid: [
      "**/transport/**",
      "**/protocol/**",
      "**/pipeline/**",
      "**/services/**",
      "**/client/**",
      "**/session/**",
      "**/lifecycle/**",
    ],
  },
];

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name='eval']", message: "No code evaluation." },
        { selector: "NewExpression[callee.name='Function']", message: "No code evaluation." },
      ],
      "no-restricted-imports": ["error", { paths: [{ name: "node:vm", message: "No code evaluation." }] }],
    },
  },
  ...boundaries.map(({ from, forbid }) => ({
    files: [from],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "node:vm", message: "No code evaluation." }],
          patterns: [{ group: forbid, message: "Violates module boundaries (docs/architecture.md §2)." }],
        },
      ],
    },
  })),
  {
    files: ["tests/**", "examples/**", "tools/**", "*.config.{js,ts}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
