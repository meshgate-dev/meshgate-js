import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Allow explicit `any` in specific cases — tighten per module as code lands
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty files are fine during scaffold (decorators.ts)
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  {
    // Ignore build output and config files from type-checked linting
    ignores: ['dist/**', 'node_modules/**', '*.config.ts', '*.config.js'],
  },
);
