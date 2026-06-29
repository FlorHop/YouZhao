<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Column from 'primevue/column';
import ConfirmDialog from 'primevue/confirmdialog';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import DatePicker from 'primevue/datepicker';
import InputText from 'primevue/inputtext';
import RadioButton from 'primevue/radiobutton';
import Select from 'primevue/select';
import Tabs from 'primevue/tabs';
import Tab from 'primevue/tab';
import TabList from 'primevue/tablist';
import TabPanel from 'primevue/tabpanel';
import TabPanels from 'primevue/tabpanels';
import Tag from 'primevue/tag';
import type { DemoPermission, McpToken, PermissionLevel, User } from '../types';
import { defaultGroupId } from '../mockData';
import { useAppState } from '../state';

const app = useAppState();
const toast = useToast();
const confirm = useConfirm();

const selectedUserId = ref(app.state.users[0]?.id ?? '');
const userDialogVisible = ref(false);
const passwordDialogVisible = ref(false);
const tokenDialogVisible = ref(false);
const editingUserId = ref<string | null>(null);
const resettingUser = ref<User | null>(null);
const activeTab = ref('users');
const userForm = reactive({
  username: '',
  displayName: '',
  email: '',
  phone: '',
  status: 'enabled' as User['status'],
  password: ''
});

const permissionForm = reactive({
  demoLevel: null as PermissionLevel | null,
  systemSettingsManage: false,
  groupIds: [] as string[],
  demoIds: [] as string[]
});

const tokenForm = reactive({
  name: '',
  expiresAt: null as Date | null
});

const generatedToken = ref('');
const settingsLoading = ref(false);

const canManageSettings = computed(() => app.hasFunctionPermission('system-settings', 'manage'));
const canCreateToken = computed(() => app.hasFunctionPermission('demo-preview', 'manage'));
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

async function refreshSettingsData() {
  settingsLoading.value = true;
  try {
    await app.refreshAdminData();
    if (!selectedUserId.value || !app.state.users.some((user) => user.id === selectedUserId.value)) {
      selectedUserId.value = app.state.users[0]?.id ?? '';
    }
  } catch (error) {
    toast.add({ severity: 'error', summary: '加载失败', detail: (error as Error).message, life: 2800 });
  } finally {
    settingsLoading.value = false;
  }
}

onMounted(refreshSettingsData);

function openCreateUser() {
  editingUserId.value = null;
  Object.assign(userForm, {
    username: '',
    displayName: '',
    email: '',
    phone: '',
    status: 'enabled',
    password: ''
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
    status: user.status,
    password: ''
  });
  userDialogVisible.value = true;
}

async function saveUser() {
  try {
    if (editingUserId.value) {
      const { password, ...payload } = userForm;
      await app.updateUser(editingUserId.value, payload);
      toast.add({ severity: 'success', summary: '用户已更新', life: 2200 });
    } else {
      const { password, ...payload } = userForm;
      const user = await app.createUser(payload, password || '123456');
      selectedUserId.value = user.id;
      toast.add({ severity: 'success', summary: '用户已创建', detail: `初始密码：${password || '123456'}`, life: 3200 });
    }
    userDialogVisible.value = false;
  } catch (error) {
    toast.add({ severity: 'error', summary: '保存失败', detail: (error as Error).message, life: 2800 });
  }
}

const passwordForm = reactive({
  password: ''
});

function openResetPassword(user: User) {
  resettingUser.value = user;
  passwordForm.password = '123456';
  passwordDialogVisible.value = true;
}

async function saveResetPassword() {
  if (!resettingUser.value) return;
  try {
    await app.resetUserPassword(resettingUser.value.id, passwordForm.password);
    passwordDialogVisible.value = false;
    toast.add({ severity: 'success', summary: '密码已重置', detail: `新密码：${passwordForm.password}`, life: 2800 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '重置失败', detail: (error as Error).message, life: 2800 });
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
    accept: async () => {
      try {
        await app.deleteUser(user.id);
        selectedUserId.value = app.state.users[0]?.id ?? '';
        toast.add({ severity: 'success', summary: '用户已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

async function savePermissions() {
  if (!selectedUserId.value) return;

  const functionPermissions = [
    ...(permissionForm.demoLevel ? [{ module: 'demo-preview' as const, level: permissionForm.demoLevel }] : []),
    ...(permissionForm.systemSettingsManage
      ? [{ module: 'system-settings' as const, level: 'manage' as const }]
      : [])
  ];

  const permissions = [
    ...permissionForm.groupIds.map((targetId) => ({
      targetType: 'group' as const,
      targetId
    })),
    ...permissionForm.demoIds.map((targetId) => ({
      targetType: 'demo' as const,
      targetId
    }))
  ];

  try {
    await app.updateUserPermissions(selectedUserId.value, functionPermissions, permissions);
    toast.add({ severity: 'success', summary: '权限已保存', life: 2200 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '保存失败', detail: (error as Error).message, life: 2800 });
  }
}

function statusSeverity(status: User['status']) {
  return status === 'enabled' ? 'success' : 'secondary';
}

function tokenStatusSeverity(status: McpToken['status']) {
  return status === 'enabled' ? 'success' : 'secondary';
}

function getUserName(userId: string) {
  return app.state.users.find((user) => user.id === userId)?.displayName ?? '未知用户';
}

function openCreateToken() {
  tokenForm.name = '';
  tokenForm.expiresAt = null;
  generatedToken.value = '';
  tokenDialogVisible.value = true;
}

async function createToken() {
  try {
    generatedToken.value = await app.createMcpToken({
      name: tokenForm.name,
      boundUserId: app.currentUser.value?.id ?? '',
      expiresAt: tokenForm.expiresAt
        ? tokenForm.expiresAt.toLocaleString('zh-CN', { hour12: false })
        : '永不过期'
    });
    toast.add({ severity: 'success', summary: 'Token 已创建', detail: '请在关闭前保存完整 Token', life: 3000 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '创建失败', detail: (error as Error).message, life: 2800 });
  }
}

async function toggleTokenStatus(token: McpToken) {
  const nextStatus = token.status === 'enabled' ? 'disabled' : 'enabled';
  try {
    await app.setMcpTokenStatus(token.id, nextStatus);
    toast.add({
      severity: 'success',
      summary: nextStatus === 'enabled' ? 'Token 已启用' : 'Token 已停用',
      life: 2200
    });
  } catch (error) {
    toast.add({ severity: 'error', summary: '操作失败', detail: (error as Error).message, life: 2800 });
  }
}

function confirmDeleteToken(token: McpToken) {
  confirm.require({
    header: '删除 Token',
    message: `确认删除 Token“${token.name}”？删除后 Agent 将无法继续使用该凭证。`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await app.deleteMcpToken(token.id);
        toast.add({ severity: 'success', summary: 'Token 已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}
</script>

<template>
  <ConfirmDialog />
  <section v-if="canManageSettings" class="page-panel">
    <div class="page-header">
      <div>
        <h1>系统设置</h1>
        <p>管理用户、功能权限与蓝图授权。</p>
      </div>
    </div>

    <div class="metric-strip">
      <div class="metric-tile">
        <span>用户数</span>
        <strong>{{ app.state.users.length }}</strong>
      </div>
      <div class="metric-tile">
        <span>蓝图分组</span>
        <strong>{{ app.state.groups.length }}</strong>
      </div>
      <div class="metric-tile">
        <span>蓝图资产</span>
        <strong>{{ app.state.demos.length }}</strong>
      </div>
      <div class="metric-tile">
        <span>MCP Token</span>
        <strong>{{ app.state.mcpTokens.length }}</strong>
      </div>
    </div>

    <Tabs v-model:value="activeTab">
      <TabList>
        <Tab value="users">用户管理</Tab>
        <Tab value="permissions">权限管理</Tab>
        <Tab value="tokens">Token 管理</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="users">
          <div class="settings-card">
            <div class="table-toolbar">
              <div>
                <strong>用户列表</strong>
                <span>新建用户默认拥有蓝图查看权限和默认分组权限</span>
              </div>
              <div class="toolbar-row">
                <Button
                  icon="pi pi-refresh"
                  label="刷新"
                  severity="secondary"
                  outlined
                  :loading="settingsLoading"
                  @click="refreshSettingsData"
                />
                <Button icon="pi pi-plus" label="新建用户" @click="openCreateUser" />
              </div>
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
                    <Button icon="pi pi-key" text severity="secondary" aria-label="重置密码" @click="openResetPassword(data)" />
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
              <div>
                <strong>选择用户</strong>
                <span>切换后编辑该用户权限</span>
              </div>
              <Select
                v-model="selectedUserId"
                :options="app.state.users"
                optionLabel="displayName"
                optionValue="id"
                class="full-width"
              />
              <div v-if="selectedUser" class="user-summary">
                <div class="user-avatar">{{ selectedUser.displayName.slice(0, 1) }}</div>
                <div>
                  <strong>{{ selectedUser.displayName }}</strong>
                  <span>{{ selectedUser.username }} · {{ selectedUser.email }}</span>
                </div>
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
                <div class="section-heading">
                  <h3>蓝图预览</h3>
                  <span>控制用户是否能查看或维护蓝图展示内容</span>
                </div>
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
                <div class="section-heading">
                  <h3>系统设置</h3>
                  <span>系统设置仅提供管理权限</span>
                </div>
                <label class="check-row">
                  <Checkbox v-model="permissionForm.systemSettingsManage" binary />
                  管理
                </label>
              </div>

              <div class="permission-section">
                <div class="section-heading">
                  <h3>蓝图分组授权</h3>
                  <span>按分组批量开放蓝图访问</span>
                </div>
                <div class="check-grid">
                  <label v-for="group in app.state.groups" :key="group.id" class="check-row">
                    <Checkbox v-model="permissionForm.groupIds" :value="group.id" />
                    {{ group.name }}
                    <Tag v-if="group.id === defaultGroupId" value="默认" severity="info" />
                  </label>
                </div>
              </div>

              <div class="permission-section">
                <div class="section-heading">
                  <h3>单个蓝图授权</h3>
                  <span>不受分组移动影响的独立授权</span>
                </div>
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

        <TabPanel value="tokens">
          <div class="settings-card">
            <div class="table-toolbar">
              <div>
                <strong>MCP Token</strong>
                <span>供 Agent 通过 MCP 获取蓝图产物或发布蓝图版本</span>
              </div>
              <Button
                v-if="canCreateToken"
                icon="pi pi-plus"
                label="新建 Token"
                @click="openCreateToken"
              />
            </div>
            <DataTable
              :value="app.state.mcpTokens"
              dataKey="id"
              paginator
              :rows="10"
              :rowsPerPageOptions="[10, 20, 50]"
              removableSort
              tableStyle="min-width: 72rem"
            >
              <Column field="name" header="Token 名称" sortable />
              <Column field="tokenPreview" header="Token 标识" />
              <Column field="boundUserId" header="绑定用户">
                <template #body="{ data }">
                  {{ getUserName(data.boundUserId) }}
                </template>
              </Column>
              <Column field="status" header="状态">
                <template #body="{ data }">
                  <Tag :severity="tokenStatusSeverity(data.status)" :value="data.status === 'enabled' ? '启用' : '停用'" />
                </template>
              </Column>
              <Column field="expiresAt" header="过期时间" sortable />
              <Column field="lastUsedAt" header="最近使用" sortable />
              <Column field="createdAt" header="创建时间" sortable />
              <Column header="操作">
                <template #body="{ data }">
                  <div class="row-actions">
                    <Button
                      :icon="data.status === 'enabled' ? 'pi pi-pause' : 'pi pi-play'"
                      text
                      :severity="data.status === 'enabled' ? 'warn' : 'success'"
                      :aria-label="data.status === 'enabled' ? '停用' : '启用'"
                      @click="toggleTokenStatus(data)"
                    />
                    <Button
                      icon="pi pi-trash"
                      text
                      severity="danger"
                      aria-label="删除"
                      @click="confirmDeleteToken(data)"
                    />
                  </div>
                </template>
              </Column>
            </DataTable>
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
        <div v-if="!editingUserId" class="form-field">
          <label for="password">初始密码</label>
          <InputText id="password" v-model="userForm.password" placeholder="不填则默认 123456" />
        </div>
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="取消" severity="secondary" outlined @click="userDialogVisible = false" />
        <Button label="保存" icon="pi pi-save" @click="saveUser" />
      </div>
    </div>
  </Dialog>

  <Dialog v-model:visible="passwordDialogVisible" modal header="重置密码" :style="{ width: '440px' }">
    <div class="dialog-form">
      <div class="form-field">
        <label>用户</label>
        <div class="bound-user-display">
          <strong>{{ resettingUser?.displayName }}</strong>
          <span>{{ resettingUser?.username }}</span>
        </div>
      </div>
      <div class="form-field">
        <label for="reset-password">新密码</label>
        <InputText id="reset-password" v-model="passwordForm.password" autofocus />
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="取消" severity="secondary" outlined @click="passwordDialogVisible = false" />
        <Button label="保存" icon="pi pi-save" @click="saveResetPassword" />
      </div>
    </div>
  </Dialog>

  <Dialog v-model:visible="tokenDialogVisible" modal header="新建 MCP Token" :style="{ width: '560px' }">
    <div class="dialog-form">
      <div v-if="generatedToken" class="token-result">
        <span>完整 Token 仅展示一次</span>
        <code>{{ generatedToken }}</code>
      </div>
      <div class="form-field">
        <label for="token-name">Token 名称</label>
        <InputText id="token-name" v-model="tokenForm.name" :disabled="Boolean(generatedToken)" />
      </div>
      <div class="form-field">
        <label for="token-user">绑定用户</label>
        <div class="bound-user-display">
          <strong>{{ app.currentUser.value?.displayName }}</strong>
          <span>{{ app.currentUser.value?.username }}</span>
        </div>
      </div>
      <div class="form-field">
        <label for="token-expire">过期时间</label>
        <DatePicker
          id="token-expire"
          v-model="tokenForm.expiresAt"
          showTime
          hourFormat="24"
          showIcon
          :disabled="Boolean(generatedToken)"
          placeholder="不选择则永不过期"
        />
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="关闭" severity="secondary" outlined @click="tokenDialogVisible = false" />
        <Button
          v-if="!generatedToken"
          label="创建"
          icon="pi pi-key"
          @click="createToken"
        />
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
  color: var(--app-muted);
  font-size: 13px;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.permission-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
}

.user-picker {
  align-self: start;
  display: grid;
  gap: 14px;
}

.user-picker span {
  display: block;
  margin-top: 4px;
  color: var(--app-muted);
  font-size: 13px;
}

.full-width {
  width: 100%;
}

.user-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--app-border-soft);
  border-radius: var(--app-radius);
  background: var(--app-panel-muted);
}

.user-summary strong,
.user-summary span {
  display: block;
}

.user-summary span {
  margin-top: 3px;
  color: var(--app-muted);
  font-size: 13px;
}

.user-avatar {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border-radius: 8px;
  color: var(--app-primary);
  background: var(--app-primary-weak);
  font-weight: 800;
}

.permission-panel {
  min-width: 0;
}

.permission-section {
  padding: 16px 0;
  border-top: 1px solid var(--app-border-soft);
}

.permission-section h3 {
  margin: 0;
  font-size: 15px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.section-heading span {
  color: var(--app-muted);
  font-size: 13px;
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
  color: var(--app-text);
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: 10px;
}

.check-grid .check-row,
.radio-row label {
  padding: 8px 10px;
  border: 1px solid var(--app-border-soft);
  border-radius: 8px;
  background: var(--app-panel-muted);
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

.token-result {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: var(--app-primary-weak);
}

.token-result span {
  color: var(--app-muted);
  font-size: 13px;
}

.token-result code {
  overflow-wrap: anywhere;
  color: var(--app-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.bound-user-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 9px 11px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
}

.bound-user-display span {
  color: var(--app-muted);
  font-size: 13px;
}
</style>
