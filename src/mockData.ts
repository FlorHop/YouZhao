import type { Demo, DemoGroup, DemoPermission, FunctionPermission, User } from './types';

export const defaultGroupId = 'group_default';

export const usersSeed: User[] = [
  {
    id: 'user_admin',
    username: 'admin',
    displayName: '系统管理员',
    email: 'admin@youzhao.local',
    phone: '13800000000',
    status: 'enabled',
    createdAt: '2026-06-12 09:00'
  },
  {
    id: 'user_demo_manager',
    username: 'demo.manager',
    displayName: 'Demo 管理者',
    email: 'manager@youzhao.local',
    phone: '13800000001',
    status: 'enabled',
    createdAt: '2026-06-12 10:00'
  },
  {
    id: 'user_viewer',
    username: 'viewer',
    displayName: 'Demo 查看者',
    email: 'viewer@youzhao.local',
    phone: '13800000002',
    status: 'enabled',
    createdAt: '2026-06-12 11:00'
  }
];

export const groupsSeed: DemoGroup[] = [
  { id: defaultGroupId, name: '默认', isDefault: true, createdAt: '2026-06-12 09:00' },
  { id: 'group_city', name: '城市治理', isDefault: false, createdAt: '2026-06-12 09:10' },
  { id: 'group_invest', name: '招商引资', isDefault: false, createdAt: '2026-06-12 09:20' }
];

export const demosSeed: Demo[] = [
  {
    id: 'demo_invest_001',
    name: '招商驾驶舱',
    summary: '展示招商线索、在谈项目、签约金额与落地进展。',
    tags: ['招商', '驾驶舱', '大屏', '项目'],
    groupId: 'group_invest',
    createdAt: '2026-06-12 09:30',
    updatedAt: '2026-06-12 09:30',
    versions: [
      {
        id: 'ver_invest_101',
        demoId: 'demo_invest_001',
        version: 'v1.1.0',
        isLatest: true,
        previewUrl: 'https://example.com/preview/demo_invest_001/v1.1.0/',
        status: 'available',
        deployedAt: '2026-06-12 12:00'
      },
      {
        id: 'ver_invest_100',
        demoId: 'demo_invest_001',
        version: 'v1.0.0',
        isLatest: false,
        previewUrl: 'https://example.com/preview/demo_invest_001/v1.0.0/',
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
    createdAt: '2026-06-12 09:35',
    updatedAt: '2026-06-12 09:35',
    versions: [
      {
        id: 'ver_city_101',
        demoId: 'demo_city_001',
        version: 'v1.1.0',
        isLatest: true,
        previewUrl: 'https://example.com/preview/demo_city_001/v1.1.0/',
        status: 'available',
        deployedAt: '2026-06-12 13:00'
      },
      {
        id: 'ver_city_100',
        demoId: 'demo_city_001',
        version: 'v1.0.0',
        isLatest: false,
        previewUrl: '',
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
    createdAt: '2026-06-12 09:40',
    updatedAt: '2026-06-12 09:40',
    versions: [
      {
        id: 'ver_delivery_100',
        demoId: 'demo_default_001',
        version: 'v1.0.0',
        isLatest: true,
        previewUrl: 'https://example.com/preview/demo_default_001/v1.0.0/',
        status: 'available',
        deployedAt: '2026-06-12 14:00'
      }
    ]
  }
];

export const functionPermissionsSeed: FunctionPermission[] = [
  { userId: 'user_admin', module: 'system-settings', level: 'manage' },
  { userId: 'user_admin', module: 'demo-preview', level: 'manage' },
  { userId: 'user_demo_manager', module: 'demo-preview', level: 'manage' },
  { userId: 'user_viewer', module: 'demo-preview', level: 'view' }
];

export const demoPermissionsSeed: DemoPermission[] = [
  { userId: 'user_admin', targetType: 'group', targetId: defaultGroupId },
  { userId: 'user_admin', targetType: 'group', targetId: 'group_city' },
  { userId: 'user_admin', targetType: 'group', targetId: 'group_invest' },
  { userId: 'user_demo_manager', targetType: 'group', targetId: defaultGroupId },
  { userId: 'user_demo_manager', targetType: 'group', targetId: 'group_city' },
  { userId: 'user_demo_manager', targetType: 'group', targetId: 'group_invest' },
  { userId: 'user_viewer', targetType: 'group', targetId: defaultGroupId },
  { userId: 'user_viewer', targetType: 'demo', targetId: 'demo_invest_001' }
];
