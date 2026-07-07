<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Chip from 'primevue/chip';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Menu from 'primevue/menu';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import Textarea from 'primevue/textarea';
import type { Demo } from '../types';
import { useAppState } from '../state';

const app = useAppState();
const toast = useToast();
const confirm = useConfirm();
const route = useRoute();
const router = useRouter();
const contextMenu = ref<InstanceType<typeof Menu> | null>(null);
const selectedVersions = reactive<Record<string, string>>({});
const draggedDemoId = ref<string | null>(null);
const draggedFromGroupId = ref<string | null>(null);
const editingDemo = ref<Demo | null>(null);
const groupDialogVisible = ref(false);
const editDialogVisible = ref(false);
const pageLoading = ref(false);
const newGroupName = ref('');
const editForm = reactive({
  name: '',
  summary: '',
  tags: '',
  groupId: ''
});
const queryForm = reactive({
  keyword: '',
  groupId: '',
  status: 'active' as 'active' | 'archived' | 'all'
});

const canViewDemo = computed(() => app.hasFunctionPermission('demo-preview', 'view'));
const canManageDemo = computed(() => app.hasFunctionPermission('demo-preview', 'manage'));

async function refreshPageData(showToast = false) {
  pageLoading.value = true;
  try {
    await app.refreshBlueprints();
    if (showToast) toast.add({ severity: 'success', summary: '已刷新', life: 1600 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '刷新失败', detail: (error as Error).message, life: 2800 });
  } finally {
    pageLoading.value = false;
  }
}

onMounted(() => {
  refreshPageData();
});

watch(
  () => route.query.groupId,
  (groupId) => {
    queryForm.groupId = typeof groupId === 'string' ? groupId : '';
  },
  { immediate: true }
);

const groupOptions = computed(() =>
  [{ id: '', name: '全部分组' }, ...app.visibleGroups.value]
);
const statusOptions = computed(() => [
  { label: '展示中', value: 'active' },
  ...(canManageDemo.value
    ? [
        { label: '已归档', value: 'archived' },
        { label: '全部状态', value: 'all' }
      ]
    : [])
]);

const filteredDemos = computed(() => {
  const keyword = queryForm.keyword.trim().toLowerCase();
  return app.visibleDemos.value.filter((demo) => {
    const matchesGroup = !queryForm.groupId || demo.groupId === queryForm.groupId;
    const matchesStatus = queryForm.status === 'all' || demo.status === queryForm.status;
    const matchesKeyword =
      !keyword ||
      demo.name.toLowerCase().includes(keyword) ||
      demo.summary.toLowerCase().includes(keyword) ||
      demo.tags.some((tag) => tag.toLowerCase().includes(keyword));
    return matchesGroup && matchesStatus && matchesKeyword;
  });
});

const groupsWithDemos = computed(() =>
  app.visibleGroups.value
    .filter((group) => !queryForm.groupId || group.id === queryForm.groupId)
    .map((group) => ({
      group,
      demos: filteredDemos.value.filter((demo) => demo.groupId === group.id)
    }))
    .filter(({ demos }) => demos.length > 0 || (!queryForm.keyword.trim() && !queryForm.groupId))
);

const contextItems = computed(() => [
  {
    label: '编辑卡片信息',
    icon: 'pi pi-pencil',
    disabled: !canManageDemo.value,
    command: openEditDialog
  },
  {
    label: '移动到默认分组',
    icon: 'pi pi-folder',
    disabled: !canManageDemo.value || !editingDemo.value || editingDemo.value.groupId === 'group_default',
    command: async () => {
      if (!editingDemo.value) return;
      try {
        await app.updateDemo(editingDemo.value.id, { groupId: 'group_default' });
        toast.add({ severity: 'success', summary: '已移动', detail: '蓝图已移动至默认分组', life: 2400 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '移动失败', detail: (error as Error).message, life: 2800 });
      }
    }
  },
  {
    label: editingDemo.value?.status === 'archived' ? '恢复蓝图' : '归档蓝图',
    icon: editingDemo.value?.status === 'archived' ? 'pi pi-history' : 'pi pi-archive',
    disabled: !canManageDemo.value || !editingDemo.value,
    command: () => {
      if (!editingDemo.value) return;
      if (editingDemo.value.status === 'archived') {
        confirmRestoreDemo(editingDemo.value);
      } else {
        confirmArchiveDemo(editingDemo.value);
      }
    }
  },
  {
    label: '删除蓝图',
    icon: 'pi pi-trash',
    disabled: !canManageDemo.value || !editingDemo.value,
    command: () => {
      if (editingDemo.value) confirmDeleteDemo(editingDemo.value);
    }
  }
]);

function getSelectedVersionId(demo: Demo) {
  if (!selectedVersions[demo.id]) {
    selectedVersions[demo.id] =
      demo.versions.find((version) => version.isLatest)?.id ?? demo.versions[0]?.id ?? '';
  }
  return selectedVersions[demo.id];
}

function openDemo(demo: Demo) {
  if (demo.status === 'archived') {
    toast.add({ severity: 'warn', summary: '蓝图已归档', detail: '恢复后才可打开预览', life: 2600 });
    return;
  }
  const versionId = getSelectedVersionId(demo);
  const version = demo.versions.find((item) => item.id === versionId);

  if (!version || version.status !== 'available' || !version.previewUrl) {
    toast.add({ severity: 'warn', summary: '版本不可用', detail: '当前版本不可用', life: 2600 });
    return;
  }

  router.push({
    path: `/blueprints/${demo.id}/preview`,
    query: { version: version.version }
  });
}

async function createGroup() {
  try {
    await app.createGroup(newGroupName.value);
    newGroupName.value = '';
    groupDialogVisible.value = false;
    toast.add({ severity: 'success', summary: '分组已创建', life: 2200 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '创建失败', detail: (error as Error).message, life: 2800 });
  }
}

function resetQuery() {
  queryForm.keyword = '';
  queryForm.groupId = '';
  queryForm.status = 'active';
}

function confirmDeleteGroup(groupId: string) {
  confirm.require({
    message: '删除分组后，该分组下的蓝图将移动至“默认”分组。是否继续？',
    header: '删除分组',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await app.deleteGroup(groupId);
        toast.add({ severity: 'success', summary: '分组已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

async function moveGroup(groupId: string, direction: -1 | 1) {
  const currentGroups = app.visibleGroups.value;
  const currentIndex = currentGroups.findIndex((group) => group.id === groupId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentGroups.length) return;

  const nextGroups = [...currentGroups];
  const [target] = nextGroups.splice(currentIndex, 1);
  nextGroups.splice(nextIndex, 0, target);

  try {
    await app.reorderGroups(nextGroups.map((group) => group.id));
    toast.add({ severity: 'success', summary: '分组顺序已更新', life: 1800 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '排序失败', detail: (error as Error).message, life: 2800 });
  }
}

function openContextMenu(event: MouseEvent, demo: Demo) {
  editingDemo.value = demo;
  contextMenu.value?.toggle(event);
}

function openEditDialog() {
  if (!editingDemo.value) return;
  editForm.name = editingDemo.value.name;
  editForm.summary = editingDemo.value.summary;
  editForm.tags = editingDemo.value.tags.join('，');
  editForm.groupId = editingDemo.value.groupId;
  editDialogVisible.value = true;
}

async function saveDemoEdit() {
  if (!editingDemo.value) return;
  const tags = editForm.tags
    .split(/[，,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  try {
    await app.updateDemo(editingDemo.value.id, {
      name: editForm.name,
      summary: editForm.summary,
      tags,
      groupId: editForm.groupId
    });
    editDialogVisible.value = false;
    toast.add({ severity: 'success', summary: '蓝图信息已更新', life: 2200 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '保存失败', detail: (error as Error).message, life: 2800 });
  }
}

function confirmArchiveDemo(demo: Demo) {
  confirm.require({
    message: `归档后“${demo.name}”将不再出现在默认蓝图展示列表，但可在已归档中恢复。是否继续？`,
    header: '归档蓝图',
    icon: 'pi pi-archive',
    rejectLabel: '取消',
    acceptLabel: '归档',
    accept: async () => {
      try {
        await app.archiveDemo(demo.id);
        toast.add({ severity: 'success', summary: '蓝图已归档', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '归档失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

function confirmRestoreDemo(demo: Demo) {
  confirm.require({
    message: `恢复后“${demo.name}”将重新进入蓝图展示列表。是否继续？`,
    header: '恢复蓝图',
    icon: 'pi pi-history',
    rejectLabel: '取消',
    acceptLabel: '恢复',
    accept: async () => {
      try {
        await app.restoreDemo(demo.id);
        toast.add({ severity: 'success', summary: '蓝图已恢复', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '恢复失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

function confirmDeleteDemo(demo: Demo) {
  confirm.require({
    message: `删除后“${demo.name}”及其已发布产物将不可恢复。建议先归档确认无误后再删除。是否继续？`,
    header: '删除蓝图',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await app.deleteDemo(demo.id);
        delete selectedVersions[demo.id];
        toast.add({ severity: 'success', summary: '蓝图已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
}

function onDragStart(demo: Demo) {
  if (!canManageDemo.value) return;
  draggedDemoId.value = demo.id;
  draggedFromGroupId.value = demo.groupId;
}

async function onDrop(groupId: string) {
  if (!canManageDemo.value || !draggedDemoId.value) return;
  if (draggedFromGroupId.value === groupId) {
    draggedDemoId.value = null;
    draggedFromGroupId.value = null;
    return;
  }
  const demoId = draggedDemoId.value;
  draggedDemoId.value = null;
  draggedFromGroupId.value = null;
  try {
    await app.updateDemo(demoId, { groupId });
    toast.add({ severity: 'success', summary: '分组已变更', life: 1800 });
  } catch (error) {
    toast.add({ severity: 'error', summary: '分组变更失败', detail: (error as Error).message, life: 2800 });
  }
}
</script>

<template>
  <Menu ref="contextMenu" :model="contextItems" popup />
  <section v-if="canViewDemo" class="page-panel demo-page">
    <div class="page-header">
      <div>
        <h1>蓝图展示</h1>
        <p>按分组查看已授权蓝图，选择版本后点击卡片新页签打开。</p>
      </div>
      <div class="toolbar-row">
        <Button
          icon="pi pi-refresh"
          label="刷新"
          severity="secondary"
          outlined
          :loading="pageLoading"
          @click="refreshPageData(true)"
        />
        <Button
          v-if="canManageDemo"
          icon="pi pi-plus"
          label="新建分组"
          @click="groupDialogVisible = true"
        />
      </div>
    </div>

    <div class="query-panel">
      <div class="query-field keyword-field">
        <i class="pi pi-search" />
        <InputText
          v-model="queryForm.keyword"
          placeholder="查询蓝图名称、概述或标签"
          aria-label="查询蓝图"
        />
      </div>
      <Select
        v-model="queryForm.groupId"
        :options="groupOptions"
        optionLabel="name"
        optionValue="id"
        class="group-filter"
        aria-label="筛选分组"
      />
      <Select
        v-if="canManageDemo"
        v-model="queryForm.status"
        :options="statusOptions"
        optionLabel="label"
        optionValue="value"
        class="status-filter"
        aria-label="筛选蓝图状态"
      />
      <Button label="重置" icon="pi pi-filter-slash" severity="secondary" outlined @click="resetQuery" />
    </div>

    <div v-if="groupsWithDemos.length === 0" class="empty-state">
      未找到匹配的分组或蓝图
    </div>

    <div v-else class="group-stack">
      <section
        v-for="{ group, demos } in groupsWithDemos"
        :key="group.id"
        class="group-section"
        @dragover.prevent
        @drop="onDrop(group.id)"
      >
        <div class="group-header">
          <div>
            <div class="group-title-row">
              <h2>{{ group.name }}</h2>
              <Tag v-if="group.isDefault" value="默认" severity="info" />
            </div>
            <span>{{ demos.length }} 个蓝图</span>
          </div>
          <Button
            v-if="canManageDemo && !group.isDefault"
            icon="pi pi-trash"
            text
            severity="danger"
            aria-label="删除分组"
            v-tooltip.top="'删除分组'"
            @click="confirmDeleteGroup(group.id)"
          />
          <div v-if="canManageDemo && !queryForm.keyword.trim() && !queryForm.groupId" class="group-order-actions">
            <Button
              icon="pi pi-arrow-up"
              text
              severity="secondary"
              aria-label="上移分组"
              v-tooltip.top="'上移分组'"
              :disabled="group.isDefault || app.visibleGroups.value.findIndex((item) => item.id === group.id) === 0"
              @click="moveGroup(group.id, -1)"
            />
            <Button
              icon="pi pi-arrow-down"
              text
              severity="secondary"
              aria-label="下移分组"
              v-tooltip.top="'下移分组'"
              :disabled="group.isDefault || app.visibleGroups.value.findIndex((item) => item.id === group.id) === app.visibleGroups.value.length - 1"
              @click="moveGroup(group.id, 1)"
            />
          </div>
        </div>

        <div v-if="demos.length === 0" class="group-empty">暂无蓝图，拖动卡片到此分组</div>
        <div v-else class="demo-grid">
          <article
            v-for="demo in demos"
            :key="demo.id"
            class="demo-card"
            :class="{ archived: demo.status === 'archived' }"
            :draggable="canManageDemo"
            @dragstart="onDragStart(demo)"
            @contextmenu.prevent="openContextMenu($event, demo)"
            @click="openDemo(demo)"
          >
            <div class="demo-card-top">
              <div class="demo-icon">
                <i class="pi pi-window-maximize" />
              </div>
              <div class="demo-heading">
                <span>{{ demo.name }}</span>
                <small>
                  {{ demo.versions.length }} 个版本
                  <Tag v-if="demo.status === 'archived'" value="已归档" severity="secondary" />
                </small>
              </div>
              <Button
                v-if="canManageDemo"
                icon="pi pi-ellipsis-v"
                text
                rounded
                severity="secondary"
                aria-label="更多操作"
                @click.stop="openContextMenu($event, demo)"
              />
            </div>

            <p class="demo-summary">{{ demo.summary }}</p>
            <div class="tag-row">
              <Chip v-for="tag in demo.tags.slice(0, 4)" :key="tag" :label="tag" />
              <Chip v-if="demo.tags.length > 4" :label="`+${demo.tags.length - 4}`" />
            </div>
            <div class="version-row" @click.stop>
              <div>
                <span>当前版本</span>
                <strong>{{ demo.versions.find((item) => item.id === getSelectedVersionId(demo))?.version }}</strong>
              </div>
              <Select
                v-model="selectedVersions[demo.id]"
                :options="demo.versions"
                optionLabel="version"
                optionValue="id"
                class="version-select"
              />
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>

  <div v-else class="denied-state">当前用户没有蓝图预览权限</div>

  <Dialog v-model:visible="groupDialogVisible" modal header="新建分组" :style="{ width: '420px' }">
    <div class="dialog-form">
      <div class="form-field">
        <label for="group-name">分组名称</label>
        <InputText id="group-name" v-model="newGroupName" autofocus />
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="取消" severity="secondary" outlined @click="groupDialogVisible = false" />
        <Button label="创建" icon="pi pi-plus" @click="createGroup" />
      </div>
    </div>
  </Dialog>

  <Dialog v-model:visible="editDialogVisible" modal header="编辑蓝图信息" :style="{ width: '560px' }">
    <div class="dialog-form">
      <div class="form-field">
        <label for="demo-name">蓝图名称</label>
        <InputText id="demo-name" v-model="editForm.name" />
      </div>
      <div class="form-field">
        <label for="demo-summary">概述</label>
        <Textarea id="demo-summary" v-model="editForm.summary" rows="4" />
      </div>
      <div class="form-field">
        <label for="demo-tags">标签</label>
        <InputText id="demo-tags" v-model="editForm.tags" placeholder="使用逗号分隔" />
      </div>
      <div class="form-field">
        <label for="demo-group">分组</label>
        <Select id="demo-group" v-model="editForm.groupId" :options="app.state.groups" optionLabel="name" optionValue="id" />
      </div>
      <div class="toolbar-row dialog-actions">
        <Button label="取消" severity="secondary" outlined @click="editDialogVisible = false" />
        <Button label="保存" icon="pi pi-save" @click="saveDemoEdit" />
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.query-panel {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 220px 160px auto;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
}

.query-field {
  position: relative;
}

.query-field i {
  position: absolute;
  top: 50%;
  left: 12px;
  z-index: 1;
  color: var(--app-muted);
  transform: translateY(-50%);
}

.query-field :deep(.p-inputtext) {
  width: 100%;
  padding-left: 36px;
}

.group-filter,
.status-filter {
  width: 100%;
}

.group-stack {
  display: grid;
  gap: 14px;
}

.group-section {
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.group-order-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.group-header h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.2;
}

.group-header span {
  display: block;
  margin-top: 5px;
  color: var(--app-muted);
  font-size: 13px;
}

.group-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.group-empty {
  display: grid;
  place-items: center;
  height: 96px;
  border: 1px dashed var(--app-border);
  border-radius: var(--app-radius);
  color: var(--app-muted);
  background: var(--app-panel-muted);
}

.demo-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(280px, 1fr));
  gap: 12px;
}

.demo-card {
  display: flex;
  min-height: 218px;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
  box-shadow: var(--app-shadow);
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}

.demo-card:hover {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}

.demo-card.archived {
  border-style: dashed;
  background: #f8fafc;
  opacity: 0.82;
}

.demo-card.archived:hover {
  border-color: rgba(100, 116, 139, 0.44);
}

.demo-card-top {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  margin-bottom: 14px;
}

.demo-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  color: var(--app-primary);
  background: var(--app-primary-weak);
}

.demo-heading {
  min-width: 0;
  flex: 1;
}

.demo-heading span,
.demo-heading small {
  display: block;
}

.demo-heading span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}

.demo-heading small {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: var(--app-muted);
  font-size: 12px;
}

.demo-summary {
  display: -webkit-box;
  min-height: 43px;
  margin: 0 0 12px;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 32px;
  margin-bottom: 14px;
}

.tag-row :deep(.p-chip) {
  border-radius: 6px;
  background: var(--app-panel-muted);
  color: var(--app-muted);
  font-size: 12px;
}

.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--app-border-soft);
}

.version-row span,
.version-row strong {
  display: block;
}

.version-row span {
  color: var(--app-muted);
  font-size: 13px;
}

.version-row strong {
  margin-top: 2px;
  font-size: 13px;
}

.version-select {
  width: 128px;
}

.dialog-actions {
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
