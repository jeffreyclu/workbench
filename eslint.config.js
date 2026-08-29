import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.workbench-runtime', 'dist', 'data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS helper scripts run under Node; typescript-eslint already turns
    // no-undef off for TypeScript, so only these files need the globals.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    // An underscore prefix is this codebase's marker for a binding that exists
    // only to satisfy a signature or a destructuring position.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
