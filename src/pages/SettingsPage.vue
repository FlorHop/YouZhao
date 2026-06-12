<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Column from 'primevue/column';
import ConfirmDialog from 'primevue/confirmdialog';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import RadioButton from 'primevue/radiobutton';
import Select from 'primevue/select';
import Tabs from 'primevue/tabs';
import Tab from 'primevue/tab';
import TabList from 'primevue/tablist';
import TabPanel from 'primevue/tabpanel';
import TabPanels from 'primevue/tabpanels';
import Tag from 'primevue/tag';
import type { DemoPermission, PermissionLevel, User } from '../types';
import { defaultGroupId } from '../mockData';
import { useAppState } from '../state';

const app = useAppState();
const toast = useToast();
const confirm = useConfirm();

const selectedUserId = ref(app.state.users[0]?.id ?? '');
const userDialogVisible = ref(false);
const editingUserId = ref<string | null>(null);
const activeTab = ref('users');
const userForm = reactive({
  username: '',
  displayName: '',
  email: '',
  phone: '',
  status: 'enabled' as User['status']
});

const permissionForm = reactive({
  demoLevel: null as PermissionLevel | null,
  systemSettingsManage: false,
  groupIds: [] as string[],
  demoIds: [] as string[]
});

const canManageSettings = computed(() => app.hasFunctionPermission('system-settings', 'manage'));
const selectedUser = computed(() => app.state.users.find((user) => user.id === selectedUserId.value));

watch(
  selectedUserId,
  (userId) => {
    permissionForm.demoLevel = app.getFunctionLevel(userId, 'demo-preview');
    permissionForm.systemSettingsManage = app.getFunctionLevel(userId, 'system-settings') === 'manage';
    const permissions = app.getDemoPermissions(userId);
    permissionForm.groupIds = permissions
      .filter((permission) => permission.targetType === 'group')
      .map((permission) => permission.targetId);
    permissionForm.demoIds = permissions
      .filter((permission) => permission.targetType === 'demo')
      .map((permission) => permission.targetId);
  },
  { immediate: true }
);

function openCreateUser() {
  editingUserId.value = null;
  Object.assign(userForm, {
    username: '',
    displayName: '',
    email: '',
    phone: '',
    status: 'enabled'
  });
  userDialogVisible.value = true;
}

function openEditUser(user: User) {
  editingUserId.value = user.id;
  Object.assign(userForm, {
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    status: user.status
  });
  userDialogVisible.value = true;
}

function saveUser() {
  try {
    if (editingUserId.value) {
      app.updateUser(editingUserId.value, userForm);
      toast.add({ severity: 'success', summary: '用户已更新', life: 2200 });
    } else {
      app.createUser(userForm);
      toast.add({ severity: 'success', summary: '用户已创建', detail: '已默认开放 Demo 查看与默认分组', life: 2800 });
    }
    userDialogVisible.value = false;
  } catch (error) {
    toast.add({ severity: 'error', summary: '保存失败', detail: (error as Error).message, life: 2800 });
  }
}

function confirmDeleteUser(user: User) {
  confirm.require({
    header: '删除用户',
    message: `确认删除用户“${user.displayName}”？`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: () => {
      try {
        app.deleteUser(user.id);
        selectedUserId.value = app.state.users[0]?.id ?? '';
        toast.add({ severity: 'success', summary: '用户已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

function savePermissions() {
  if (!selectedUserId.value) return;

  app.setFunctionPermission(selectedUserId.value, 'demo-preview', permissionForm.demoLevel);
  app.setFunctionPermission(
    selectedUserId.value,
    'system-settings',
    permissionForm.systemSettingsManage ? 'manage' : null
  );

  const permissions: DemoPermission[] = [
    ...permissionForm.groupIds.map((targetId) => ({
      userId: selectedUserId.value,
      targetType: 'group' as const,
      targetId
    })),
    ...permissionForm.demoIds.map((targetId) => ({
      userId: selectedUserId.value,
      targetType: 'demo' as const,
      targetId
    }))
  ];
  app.setDemoPermissions(selectedUserId.value, permissions);
  toast.add({ severity: 'success', summary: '权限已保存', life: 2200 });
}

function statusSeverity(status: User['status']) {
  return status === 'enabled' ? 'success' : 'secondary';
}
</script>

<template>
  <ConfirmDialog />
  <section v-if="canManageSettings" class="page-panel">
    <div class="page-header">
      <div>
        <h1>系统设置</h1>
        <p>管理用户、功能权限与 Demo 授权。</p>
      </div>
    </div>

    <Tabs v-model:value="activeTab">
      <TabList>
        <Tab value="users">用户管理</Tab>
        <Tab value="permissions">权限管理</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="users">
          <div class="settings-card">
            <div class="table-toolbar">
              <div>
                <strong>用户列表</strong>
                <span>新建用户默认拥有 Demo 查看权限和默认分组权限</span>
              </div>
              <Button icon="pi pi-plus" label="新建用户" @click="openCreateUser" />
            </div>
            <DataTable
              :value="app.state.users"
              dataKey="id"
              paginator
              :rows="10"
              :rowsPerPageOptions="[10, 20, 50]"
              removableSort
              tableStyle="min-width: 64rem"
            >
              <Column field="id" header="用户 ID" />
              <Column field="username" header="用户名" sortable />
              <Column field="displayName" header="姓名" sortable />
              <Column field="email" header="邮箱" />
              <Column field="phone" header="手机号" />
              <Column field="status" header="状态">
                <template #body="{ data }">
                  <Tag :severity="statusSeverity(data.status)" :value="data.status === 'enabled' ? '启用' : '停用'" />
                </template>
              </Column>
              <Column field="createdAt" header="创建时间" sortable />
              <Column header="操作">
                <template #body="{ data }">
                  <div class="row-actions">
                    <Button icon="pi pi-pencil" text aria-label="编辑" @click="openEditUser(data)" />
                    <Button icon="pi pi-trash" text severity="danger" aria-label="删除" @click="confirmDeleteUser(data)" />
                  </div>
                </template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>

        <TabPanel value="permissions">
          <div class="permission-layout">
            <div class="settings-card user-picker">
              <strong>选择用户</strong>
              <Select
                v-model="selectedUserId"
                :options="app.state.users"
                optionLabel="displayName"
                optionValue="id"
                class="full-width"
              />
              <div v-if="selectedUser" class="user-summary">
                <span>{{ selectedUser.username }}</span>
                <span>{{ selectedUser.email }}</span>
              </div>
            </div>

            <div class="settings-card permission-panel">
              <div class="table-toolbar">
                <div>
                  <strong>功能权限</strong>
                  <span>查看不可修改数据；管理包含查看能力</span>
                </div>
                <Button icon="pi pi-save" label="保存权限" @click="savePermissions" />
              </div>

              <div class="permission-section">
                <h3>Demo 预览</h3>
                <div class="radio-row">
                  <label>
                    <RadioButton v-model="permissionForm.demoLevel" inputId="demo-none" name="demo-level" :value="null" />
                    无权限
                  </label>
                  <label>
                    <RadioButton v-model="permissionForm.demoLevel" inputId="demo-view" name="demo-level" value="view" />
                    查看
                  </label>
                  <label>
                    <RadioButton v-model="permissionForm.demoLevel" inputId="demo-manage" name="demo-level" value="manage" />
                    管理
                  </label>
                </div>
              </div>

              <div class="permission-section">
                <h3>系统设置</h3>
                <label class="check-row">
                  <Checkbox v-model="permissionForm.systemSettingsManage" binary />
                  管理
                </label>
              </div>

              <div class="permission-section">
                <h3>Demo 分组授权</h3>
                <div class="check-grid">
                  <label v-for="group in app.state.groups" :key="group.id" class="check-row">
                    <Checkbox v-model="permissionForm.groupIds" :value="group.id" />
                    {{ group.name }}
                    <Tag v-if="group.id === defaultGroupId" value="默认" severity="info" />
                  </label>
                </div>
              </div>

              <div class="permission-section">
                <h3>单个 Demo 授权</h3>
                <div class="check-grid">
                  <label v-for="demo in app.state.demos" :key="demo.id" class="check-row">
                    <Checkbox v-model="permissionForm.demoIds" :value="demo.id" />
                    {{ demo.name }}
                  </label>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </section>

  <div v-else class="denied-state">当前用户没有系统设置管理权限</div>

  <Dialog v-model:visible="userDialogVisible" modal :header="editingUserId ? '修改用户' : '新建用户'" :style="{ width: '560px' }">
    <div class="dialog-form">
      <div class="form-grid">
        <div class="form-field">
          <label for="username">用户名</label>
          <InputText id="username" v-model="userForm.username" :disabled="Boolean(editingUserId)" />
        </div>
        <div class="form-field">
          <label for="display-name">姓名</label>
          <InputText id="display-name" v-model="userForm.displayName" />
        </div>
        <div class="form-field">
          <label for="email">邮箱</label>
          <InputText id="email" v-model="userForm.email" />
        </div>
        <div class="form-field">
          <label for="phone">手机号</label>
          <InputText id="phone" v-model="userForm.phone" />
        </div>
        <div class="form-field">
          <label for="status">状态</label>
          <Select
            id="status"
            v-model="userForm.status"
            :options="[
              { label: '启用', value: 'enabled' },
              { label: '停用', value: 'disabled' }
            ]"
            optionLabel="label"
            optionValue="value"
          />
        </div>
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="取消" severity="secondary" outlined @click="userDialogVisible = false" />
        <Button label="保存" icon="pi pi-save" @click="saveUser" />
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.table-toolbar strong,
.table-toolbar span {
  display: block;
}

.table-toolbar span {
  margin-top: 4px;
  color: var(--p-surface-500);
  font-size: 13px;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.permission-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
}

.user-picker {
  align-self: start;
  display: grid;
  gap: 12px;
}

.full-width {
  width: 100%;
}

.user-summary {
  display: grid;
  gap: 4px;
  color: var(--p-surface-500);
  font-size: 13px;
}

.permission-panel {
  min-width: 0;
}

.permission-section {
  padding: 16px 0;
  border-top: 1px solid var(--p-surface-200);
}

.permission-section h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.radio-row,
.check-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
}

.radio-row label,
.check-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  color: var(--p-surface-700);
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.dialog-actions {
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
