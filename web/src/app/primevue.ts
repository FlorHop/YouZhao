/* ─────────────────────────────────────────────────────────────────────────
 * PrimeVue 主题预设：把 Aura 的语义 token 重绑到有招的视觉体系
 *
 * 设计文档：`docs/frontend-design.md` §3「受控扩展」——PrimeVue 4 的 Styled Mode
 * 是组件层唯一实现，本文件是**体系绑定层**（与 `src/styles/tokens.css` 一一对应），
 * 因此它是唯一允许出现裸色值的地方。页面与组件不得再写色值/字号/圆角。
 *
 * 与 tokens.css 的对应关系：
 *   --bg/--surface/--surface-warm   → colorScheme.light.surface.{0,100,50}
 *   --fg/--muted/--meta             → colorScheme.light.text.{color,mutedColor}、surface.500
 *   --border/--border-soft          → colorScheme.light.surface.{300,200}
 *   --accent/-hover/-active         → semantic.primary 500/600/700
 *   --warn / --danger               → primitive.amber.500 / primitive.red.500（裁决：共用危险语义）
 *   --radius-sm/md/lg               → primitive.borderRadius.{md,xl}
 *   --elev-raised                   → overlay.modal.shadow
 * ─────────────────────────────────────────────────────────────────── */

import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/** 强调色色阶：500 即设计体系的 OpenAI Teal（`--accent`）。 */
const TEAL = {
  50: '#e8f8f3',
  100: '#c9ede2',
  200: '#96dcc7',
  300: '#63c9ab',
  400: '#37b892',
  500: '#10a37f',
  600: '#0a7a5e',
  700: '#0a6350',
  800: '#095043',
  900: '#084438',
  950: '#04261f',
} as const;

/** 危险色阶：500 即 `--danger`（校验错误与破坏性动作共用）。 */
const RED = {
  50: '#fdeced',
  100: '#fbd8d9',
  200: '#f7b1b3',
  300: '#f3898c',
  400: '#f4686c',
  500: '#ef4146',
  600: '#d93a3f',
  700: '#b93034',
  800: '#8f2529',
  900: '#6b1c1f',
  950: '#3d1012',
} as const;

/** 警示色阶：500 即 `--warn`（范围缺失、配置不完整等可继续的提示）。 */
const AMBER = {
  50: '#fef6e8',
  100: '#fdeccf',
  200: '#fbdb9e',
  300: '#f9c96d',
  400: '#f8bd57',
  500: '#f5a623',
  600: '#d98c12',
  700: '#b3720a',
  800: '#8c5908',
  900: '#664206',
  950: '#3d2704',
} as const;

/** 中性色阶：与 `--bg/--surface/--border/--fg/--muted/--meta` 对齐。 */
const NEUTRAL = {
  0: '#ffffff',
  50: '#fafafa',
  100: '#f5f5f5',
  200: '#ededed',
  300: '#e5e5e5',
  400: '#d4d4d4',
  500: '#9b9b9b',
  600: '#6e6e6e',
  700: '#454545',
  800: '#1a1a1a',
  900: '#0d0d0d',
  950: '#000000',
} as const;

export const YouzhaoPreset = definePreset(Aura, {
  primitive: {
    borderRadius: {
      none: '0',
      xs: '4px',
      sm: '8px',
      md: '12px', // 按钮、输入框
      lg: '14px',
      xl: '16px', // 卡片、对话框
    },
    primary: TEAL,
    red: RED,
    amber: AMBER,
  },

  semantic: {
    transitionDuration: '220ms',
    disabledOpacity: '0.45',
    focusRing: {
      width: '3px',
      style: 'solid',
      color: 'rgba(16, 163, 127, 0.12)',
      offset: '0',
      shadow: 'none',
    },
    primary: {
      50: TEAL[50],
      100: TEAL[100],
      200: TEAL[200],
      300: TEAL[300],
      400: TEAL[400],
      500: TEAL[500],
      600: TEAL[600],
      700: TEAL[700],
      800: TEAL[800],
      900: TEAL[900],
      950: TEAL[950],
    },
    formField: {
      paddingX: '12px',
      paddingY: '6px',
      sm: { fontSize: '13px', paddingX: '10px', paddingY: '4px' },
      borderRadius: '{border.radius.md}',
      // 体系约定：焦点用 3px 柔和光环，不用描边变色（Aura 默认 width 0）
      focusRing: {
        width: '3px',
        style: 'solid',
        color: 'rgba(16, 163, 127, 0.12)',
        offset: '0',
        shadow: 'none',
      },
      transitionDuration: '220ms',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{primary.500}',
          contrastColor: '{surface.0}',
          hoverColor: '{primary.600}',
          activeColor: '{primary.700}',
        },
        highlight: {
          background: '{primary.50}',
          focusBackground: '{primary.100}',
          color: '{primary.700}',
          focusColor: '{primary.800}',
        },
        mask: {
          background: 'rgba(13, 13, 13, 0.35)',
          color: '{surface.0}',
        },
        surface: {
          0: NEUTRAL[0],
          50: NEUTRAL[50],
          100: NEUTRAL[100],
          200: NEUTRAL[200],
          300: NEUTRAL[300],
          400: NEUTRAL[400],
          500: NEUTRAL[500],
          600: NEUTRAL[600],
          700: NEUTRAL[700],
          800: NEUTRAL[800],
          900: NEUTRAL[900],
          950: NEUTRAL[950],
        },
        text: {
          color: '{surface.900}',
          hoverColor: '{primary.700}',
          mutedColor: '{surface.600}',
          hoverMutedColor: '{surface.900}',
        },
        content: {
          background: '{surface.0}',
          hoverBackground: '{surface.100}',
          borderColor: '{surface.300}',
          color: '{text.color}',
          hoverColor: '{text.hover.color}',
        },
        formField: {
          background: '{surface.0}',
          disabledBackground: '{surface.100}',
          filledBackground: '{surface.50}',
          filledHoverBackground: '{surface.50}',
          filledFocusBackground: '{surface.50}',
          borderColor: '{surface.300}',
          hoverBorderColor: '{surface.400}',
          focusBorderColor: '{primary.color}',
          invalidBorderColor: '{red.500}',
          color: '{surface.900}',
          disabledColor: '{surface.500}',
          placeholderColor: '{surface.500}',
          invalidPlaceholderColor: '{red.500}',
          floatLabelColor: '{surface.600}',
          floatLabelFocusColor: '{primary.color}',
          floatLabelActiveColor: '{surface.600}',
          floatLabelInvalidColor: '{red.500}',
          iconColor: '{surface.500}',
          shadow: 'none',
        },
        overlay: {
          select: {
            background: '{surface.0}',
            borderColor: '{surface.300}',
            color: '{text.color}',
          },
          popover: {
            background: '{surface.0}',
            borderColor: '{surface.300}',
            color: '{text.color}',
          },
          modal: {
            background: '{surface.0}',
            borderColor: '{surface.300}',
            color: '{text.color}',
            borderRadius: '{border.radius.xl}',
            shadow: '0 4px 16px rgba(13, 13, 13, 0.06)',
          },
        },
      },
    },
  },

  components: {
    button: {
      root: {
        borderRadius: '{border.radius.md}',
        paddingX: '16px',
        paddingY: '8px',
        gap: '6px',
        label: { fontWeight: '500' },
        // 光环颜色由 {focus.ring.color} 决定（见 semantic.focusRing），此处只能给宽/线型/偏移
        focusRing: { width: '3px', style: 'solid', offset: '0' },
      },
    },
    card: {
      // 体系禁止装饰性阴影：卡片靠 1px 描边与留白区分
      root: { borderRadius: '{border.radius.xl}', shadow: 'none' },
      body: { padding: '20px', gap: '12px' },
      title: { fontSize: '18px', fontWeight: '500' },
      subtitle: { color: '{text.muted.color}' },
    },
    dialog: {
      root: { borderRadius: '{border.radius.xl}' },
      header: { padding: '16px 20px' },
      content: { padding: '0 20px 8px' },
      footer: { padding: '12px 20px 16px', gap: '8px' },
      title: { fontSize: '18px', fontWeight: '500' },
    },
    datatable: {
      // 表头弱化、仅横向分隔线、无斑马纹与外框（设计文档 §3 数据表约定）
      header: {
        background: 'transparent',
        borderColor: '{surface.300}',
        borderWidth: '0 0 1px 0',
        color: '{text.muted.color}',
        padding: '10px 16px',
      },
      headerCell: {
        background: 'transparent',
        hoverBackground: 'transparent',
        color: '{text.muted.color}',
        padding: '10px 16px',
      },
      columnTitle: { fontWeight: '500' },
      row: {
        background: 'transparent',
        color: '{text.color}',
        hoverBackground: '{surface.50}',
      },
      bodyCell: {
        // Aura 的 bodyCell 只有 borderColor/padding；行分隔线由 header.borderWidth 与表格自身边框给出
        borderColor: '{surface.200}',
        padding: '10px 16px',
      },
      footer: {
        background: 'transparent',
        borderColor: '{surface.300}',
        color: '{text.color}',
      },
    },
    chip: {
      root: { borderRadius: '9999px', paddingX: '10px', paddingY: '2px', gap: '4px' },
    },
    tag: {
      root: { borderRadius: '9999px', padding: '2px 10px', fontSize: '12px', fontWeight: '500' },
    },
    toast: {
      root: { width: '24rem', borderRadius: '{border.radius.xl}' },
    },
    inputtext: {
      root: { transitionDuration: '220ms' },
    },
  },
});
