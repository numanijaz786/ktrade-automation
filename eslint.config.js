// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Floating-point conversions are banned in financial code — use @ktrade/finance-core `d()` instead. */
const noFloatMoney = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.name='parseFloat']",
      message: 'No floats for money: use d() from finance-core.',
    },
    {
      selector: "CallExpression[callee.name='Number']",
      message: 'No Number() for money: use d() / fromInt().',
    },
    { selector: "MemberExpression[object.name='Math']", message: 'No Math.* on money: use Decimal methods.' },
    {
      selector: "CallExpression[callee.property.name='toNumber']",
      message: 'No Decimal#toNumber() in domain code.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
    },
  },
  {
    // NestJS DI reads constructor param types at runtime via emitDecoratorMetadata. Telling the parser
    // stops `consistent-type-imports` from "fixing" injected classes into type-only imports (which breaks DI).
    files: ['apps/api/**/*.ts'],
    languageOptions: { parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true } },
  },
  {
    files: ['packages/finance-core/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: noFloatMoney,
  },
  prettier,
);
