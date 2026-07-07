import type { Demo, DemoGroup, DemoPermission, FunctionPermission, McpToken, User } from './types';

export const defaultGroupId = 'group_default';

export const usersSeed: User[] = [];

export const authCredentialsSeed: Record<string, string> = {};

export const groupsSeed: DemoGroup[] = [
  { id: defaultGroupId, name: '默认', isDefault: true, order: 0, createdAt: '2026-06-12 09:00' },
  { id: 'group_city', name: '城市治理', isDefault: false, order: 10, createdAt: '2026-06-12 09:10' },
  { id: 'group_invest', name: '招商引资', isDefault: false, order: 20, createdAt: '2026-06-12 09:20' }
];

export const demosSeed: Demo[] = [
  {
    id: 'demo_invest_001',
    name: '招商驾驶舱',
    summary: '展示招商线索、在谈项目、签约金额与落地进展。',
    tags: ['招商', '驾驶舱', '大屏', '项目'],
    groupId: 'group_invest',
    status: 'active',
    createdAt: '2026-06-12 09:30',
    updatedAt: '2026-06-12 09:30',
    versions: [
      {
        id: 'ver_invest_101',
        demoId: 'demo_invest_001',
        version: 'v1.1.0',
        isLatest: true,
        previewUrl: '/blueprints/demo_invest_001/preview?version=v1.1.0',
        artifactUrl: '/preview-artifacts/demo_invest_001/v1.1.0/index.html',
        markdown: '# 招商驾驶舱 v1.1.0\n\n## 蓝图说明\n\n展示招商线索、在谈项目、签约金额与落地进展。\n\n## 页面模块\n\n- 核心指标总览\n- 招商阶段漏斗\n- 区域项目分布\n- 重点项目推进\n- 风险与待办提醒\n\n## 版本说明\n\n优化项目进度模块，补充风险提示和转化率指标。',
        status: 'available',
        deployedAt: '2026-06-12 12:00'
      },
      {
        id: 'ver_invest_100',
        demoId: 'demo_invest_001',
        version: 'v1.0.0',
        isLatest: false,
        previewUrl: '/blueprints/demo_invest_001/preview?version=v1.0.0',
        artifactUrl: '/preview-artifacts/demo_invest_001/v1.0.0/index.html',
        markdown: '# 招商驾驶舱 v1.0.0\n\n## 蓝图说明\n\n首版招商驾驶舱，覆盖项目总量、签约金额、落地项目与区域排名。\n\n## 页面模块\n\n- 指标卡片\n- 区域排行\n- 项目列表\n- 趋势分析',
        status: 'available',
        deployedAt: '2026-06-11 12:00'
      }
    ]
  },
  {
    id: 'demo_city_001',
    name: '城市运行总览',
    summary: '面向领导驾驶舱的城市运行态势、事件、指标和预警总览。',
    tags: ['城市治理', '态势感知', '预警'],
    groupId: 'group_city',
    status: 'active',
    createdAt: '2026-06-12 09:35',
    updatedAt: '2026-06-12 09:35',
    versions: [
      {
        id: 'ver_city_101',
        demoId: 'demo_city_001',
        version: 'v1.1.0',
        isLatest: true,
        previewUrl: '/blueprints/demo_city_001/preview?version=v1.1.0',
        artifactUrl: '/preview-artifacts/demo_city_001/v1.1.0/index.html',
        markdown: '# 城市运行总览 v1.1.0\n\n## 蓝图说明\n\n面向城市治理场景，展示运行态势、事件、指标和预警。',
        status: 'available',
        deployedAt: '2026-06-12 13:00'
      },
      {
        id: 'ver_city_100',
        demoId: 'demo_city_001',
        version: 'v1.0.0',
        isLatest: false,
        previewUrl: '',
        artifactUrl: '',
        markdown: '# 城市运行总览 v1.0.0\n\n当前版本不可用。',
        status: 'unavailable',
        deployedAt: '2026-06-10 13:00'
      }
    ]
  },
  {
    id: 'demo_default_001',
    name: '项目交付进度看板',
    summary: '展示项目阶段、风险、评审、原型版本和交付物状态。',
    tags: ['交付', '项目管理', '看板'],
    groupId: defaultGroupId,
    status: 'active',
    createdAt: '2026-06-12 09:40',
    updatedAt: '2026-06-12 09:40',
    versions: [
      {
        id: 'ver_delivery_100',
        demoId: 'demo_default_001',
        version: 'v1.0.0',
        isLatest: true,
        previewUrl: '/blueprints/demo_default_001/preview?version=v1.0.0',
        artifactUrl: '/preview-artifacts/demo_default_001/v1.0.0/index.html',
        markdown: '# 项目交付进度看板 v1.0.0\n\n## 蓝图说明\n\n展示项目阶段、风险、评审、原型版本和交付物状态。',
        status: 'available',
        deployedAt: '2026-06-12 14:00'
      }
    ]
  }
];

export const functionPermissionsSeed: FunctionPermission[] = [];

export const demoPermissionsSeed: DemoPermission[] = [];

export const mcpTokensSeed: McpToken[] = [];
