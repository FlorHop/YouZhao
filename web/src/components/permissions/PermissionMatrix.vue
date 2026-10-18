<script setup lang="ts">
/**
 * 矩阵式权限说明区（设计 `docs/frontend-design.md` §9 文案规范：权限边界要同时说明
 * 「能做什么」和「不能做什么」；条目取自 `docs/permission-design.md` §2 与 §3 三张矩阵表）。
 * 纯静态说明，不读取任何接口。
 */
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';

interface MatrixRow {
  id: string;
  identity: string;
  accounts: string;
  authorization: string;
  capability: string;
  limits: string;
}

const rows: MatrixRow[] = [
  {
    id: 'owner',
    identity: '平台所有者',
    accounts: '全部账号：创建、编辑资料、停用/启用、重置密码、删除、改派管理归属、任命或撤销用户管理员。',
    authorization: '可以为任意用户授予或撤销任意分组与单蓝图的查看权，并为其授予蓝图管理与蓝图发布能力。',
    capability: '是唯一能授予或撤销业务能力的人。',
    limits:
      '不能修改自己的身份（系统会拒绝），本期也不提供所有者移交入口；查看范围在全平台天然完整。',
  },
  {
    id: 'user_admin',
    identity: '用户管理员',
    accounts:
      '仅限平台所有者指派给自己管理的普通用户：编辑资料、停用/启用、重置密码，并可创建普通用户（新用户自动归自己）。',
    authorization:
      '仅在自己被授予的查看范围内，为自己管理的用户增删查看权；可以看到并保留他人授予的只读项，但无权取消。',
    capability: '不能授予或撤销任何业务能力。',
    limits:
      '不能管理自己、其他用户管理员或平台所有者；不能删除用户（只能停用）；不能改派管理归属、不能变更身份；授权不得超出自己的可委派范围（可委派范围等于本人被授予的查看范围）。',
  },
  {
    id: 'member',
    identity: '普通用户',
    accounts: '不提供账号管理能力，「用户」「权限」入口不会渲染。',
    authorization: '不提供授予查看权的能力。',
    capability:
      '能力由平台所有者按资源范围授予：拿到蓝图管理后可在范围内维护元数据与分组归属，拿到蓝图发布后可在范围内发布新版本。',
    limits: '能做什么只取决于被授予的查看权与业务能力；身份本身不带来任何账号管理权或业务能力。',
  },
];

const columns: { field: keyof Omit<MatrixRow, 'id'>; header: string }[] = [
  { field: 'identity', header: '身份' },
  { field: 'accounts', header: '账号管理' },
  { field: 'authorization', header: '蓝图授权' },
  { field: 'capability', header: '业务能力' },
  { field: 'limits', header: '边界（不能做什么）' },
];
</script>

<template>
  <DataTable :value="rows" data-key="id" table-style="min-width: 64rem">
    <Column v-for="column in columns" :key="column.field" :header="column.header">
      <template #body="slotProps">
        <span v-if="column.field === 'identity'">
          <strong>{{ (slotProps.data as MatrixRow).identity }}</strong>
        </span>
        <span v-else class="caption">{{ (slotProps.data as MatrixRow)[column.field] }}</span>
      </template>
    </Column>
  </DataTable>
</template>
