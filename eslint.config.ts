import antfu, { GLOB_MARKDOWN } from '@antfu/eslint-config'

export default await antfu(
  {
    yaml: false,
    ignores: [
      'skills/eventa/SKILL.md',
    ],
    rules: {
      'antfu/import-dedupe': 'error',
      'import/order': 'off',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      'style/padding-line-between-statements': 'error',
      'vue/prefer-separate-static-class': 'off',
      'yaml/plain-scalar': 'off',
      'markdown/require-alt-text': 'off',
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'type-builtin',
            'type-import',
            'type-internal',
            ['type-parent', 'type-sibling', 'type-index'],
            'default-value-builtin',
            'named-value-builtin',
            'value-builtin',
            'default-value-external',
            'named-value-external',
            'value-external',
            'default-value-internal',
            'named-value-internal',
            'value-internal',
            ['default-value-parent', 'default-value-sibling', 'default-value-index'],
            ['named-value-parent', 'named-value-sibling', 'named-value-index'],
            ['wildcard-value-parent', 'wildcard-value-sibling', 'wildcard-value-index'],
            ['value-parent', 'value-sibling', 'value-index'],
            'side-effect',
            'style',
          ],
          newlinesBetween: 'always',
        },
      ],
    },
  },
  {
    ignores: [GLOB_MARKDOWN],
    rules: {
      'no-console': 'off',
    },
  },
)
