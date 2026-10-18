import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
  },
  {
    // 构建/开发脚本跑在 node 里：声明 Node 全局，避免 no-undef 误报（如 URL、process）
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      // TS 已做未定义标识符检查，且 no-undef 不认 DOM/Node 全局类型（Event、process…）
      'no-undef': 'off',
      // 无 Prettier 的纯 ESLint 项目里，这两条格式规则只会变成噪声（不影响可读性约束）
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      // 界面文案即产品的一部分：组件里的中文提示必须走既定文案，不做"未使用变量"式静默
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      // 设计要求：不在组件里写死视觉取值（色值/字号/圆角）
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '不要在组件里写死色值：使用设计体系 token（docs/frontend-design.md §2）',
        },
      ],
    },
  },
  {
    files: ['src/styles/**', 'src/app/primevue.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
