import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      // Plugin SDK boundary: args/outputs cross an untyped JSON boundary
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-spread": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      // Async adapters/stubs without await are intentional (sync stubs behind async ports)
      "@typescript-eslint/require-await": "off",
      // Template expressions with numbers/regexps are used for CLI output formatting
      "@typescript-eslint/restrict-template-expressions": "off",
      // Zod `.url()` deprecation — schema style is intentional for this version
      "@typescript-eslint/no-deprecated": "off",
      // Defensive ?? on SDK-provided values is intentional
      "@typescript-eslint/no-unnecessary-condition": "off",
      // JSON.parse results at trust boundaries
      "@typescript-eslint/no-base-to-string": "off",
      // Plugin tool handlers receive args/context they may not need
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Enum comparison false positive on string literal unions
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
