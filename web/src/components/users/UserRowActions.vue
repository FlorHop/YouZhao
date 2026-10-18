<script setup lang="ts">
/**
 * 用户行内操作（设计 P4，docs/frontend-design.md §6 / §7）。
 *
 * 越权入口**不渲染**：这里只负责按身份裁剪入口，服务端仍会逐接口校验，
 * 前端不是安全边界。
 *   - 所有者的行：仅显示 `受保护` 说明文字，没有任何危险操作。
 *   - `改派管理员`（整体替换归属）与 `删除`：仅平台所有者（docs/permission-design.md §3.1）。
 *   - 用户管理员对名下普通用户只能停用，不能删除。
 */
import Button from 'primevue/button';

import type { UserRow } from '@/services/endpoints';

const props = defineProps<{
  user: UserRow;
  isOwner: boolean;
}>();

const emit = defineEmits<{
  edit: [];
  managers: [];
  permissions: [];
  toggleStatus: [];
  resetPassword: [];
  remove: [];
  promote: [];
  demote: [];
}>();
</script>

<template>
  <span v-if="props.user.identity === 'owner'" class="text-muted">受保护</span>

  <div v-else class="row-actions">
    <Button label="编辑" text size="small" @click="emit('edit')" />
    <Button v-if="props.isOwner" label="改派管理员" text size="small" @click="emit('managers')" />
    <Button label="查看权限" text size="small" @click="emit('permissions')" />
    <Button
      :label="props.user.status === 'active' ? '停用' : '启用'"
      text
      size="small"
      @click="emit('toggleStatus')"
    />
    <Button label="重置密码" text size="small" @click="emit('resetPassword')" />
    <Button
      v-if="props.isOwner"
      :label="props.user.identity === 'user_admin' ? '降级为普通用户' : '任命为管理员'"
      text
      size="small"
      @click="props.user.identity === 'user_admin' ? emit('demote') : emit('promote')"
    />
    <Button v-if="props.isOwner" label="删除" text size="small" severity="danger" @click="emit('remove')" />
  </div>
</template>
