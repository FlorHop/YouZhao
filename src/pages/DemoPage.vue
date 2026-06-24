<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Chip from 'primevue/chip';
import ConfirmDialog from 'primevue/confirmdialog';
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
const contextMenu = ref<InstanceType<typeof Menu> | null>(null);
const selectedVersions = reactive<Record<string, string>>({});
const draggedDemoId = ref<string | null>(null);
const draggedFromGroupId = ref<string | null>(null);
const editingDemo = ref<Demo | null>(null);
const groupDialogVisible = ref(false);
const editDialogVisible = ref(false);
const newGroupName = ref('');
const editForm = reactive({
  name: '',
  summary: '',
  tags: '',
  groupId: ''
});
const queryForm = reactive({
  keyword: '',
  groupId: ''
});

const canViewDemo = computed(() => app.hasFunctionPermission('demo-preview', 'view'));
const canManageDemo = computed(() => app.hasFunctionPermission('demo-preview', 'manage'));

const groupOptions = computed(() =>
  [{ id: '', name: '全部分组' }, ...app.visibleGroups.value]
);

const filteredDemos = computed(() => {
  const keyword = queryForm.keyword.trim().toLowerCase();
  return app.visibleDemos.value.filter((demo) => {
    const matchesGroup = !queryForm.groupId || demo.groupId === queryForm.groupId;
    const matchesKeyword =
      !keyword ||
      demo.name.toLowerCase().includes(keyword) ||
      demo.summary.toLowerCase().includes(keyword) ||
      demo.tags.some((tag) => tag.toLowerCase().includes(keyword));
    return matchesGroup && matchesKeyword;
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
    command: () => {
      if (!editingDemo.value) return;
      app.updateDemo(editingDemo.value.id, { groupId: 'group_default' });
      toast.add({ severity: 'success', summary: '已移动', detail: '蓝图已移动至默认分组', life: 2400 });
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
  const versionId = getSelectedVersionId(demo);
  const version = demo.versions.find((item) => item.id === versionId);

  if (!version || version.status !== 'available' || !version.previewUrl) {
    toast.add({ severity: 'warn', summary: '版本不可用', detail: '当前版本不可用', life: 2600 });
    return;
  }

  window.open(version.previewUrl, '_blank', 'noopener,noreferrer');
}

function createGroup() {
  try {
    app.createGroup(newGroupName.value);
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
}

function confirmDeleteGroup(groupId: string) {
  confirm.require({
    message: '删除分组后，该分组下的蓝图将移动至“默认”分组。是否继续？',
    header: '删除分组',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: () => {
      try {
        app.deleteGroup(groupId);
        toast.add({ severity: 'success', summary: '分组已删除', life: 2200 });
      } catch (error) {
        toast.add({ severity: 'error', summary: '删除失败', detail: (error as Error).message, life: 2800 });
      }
    }
  });
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

function saveDemoEdit() {
  if (!editingDemo.value) return;
  const tags = editForm.tags
    .split(/[，,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  app.updateDemo(editingDemo.value.id, {
    name: editForm.name,
    summary: editForm.summary,
    tags,
    groupId: editForm.groupId
  });
  editDialogVisible.value = false;
  toast.add({ severity: 'success', summary: '蓝图信息已更新', life: 2200 });
}

function onDragStart(demo: Demo) {
  if (!canManageDemo.value) return;
  draggedDemoId.value = demo.id;
  draggedFromGroupId.value = demo.groupId;
}

function onDrop(groupId: string) {
  if (!canManageDemo.value || !draggedDemoId.value) return;
  if (draggedFromGroupId.value === groupId) {
    draggedDemoId.value = null;
    draggedFromGroupId.value = null;
    return;
  }
  app.updateDemo(draggedDemoId.value, { groupId });
  draggedDemoId.value = null;
  draggedFromGroupId.value = null;
  toast.add({ severity: 'success', summary: '分组已变更', life: 1800 });
}
</script>

<template>
  <ConfirmDialog />
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
          @click="toast.add({ severity: 'info', summary: '已刷新本地数据', life: 1600 })"
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
        </div>

        <div v-if="demos.length === 0" class="group-empty">暂无蓝图，拖动卡片到此分组</div>
        <div v-else class="demo-grid">
          <article
            v-for="demo in demos"
            :key="demo.id"
            class="demo-card"
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
                <small>{{ demo.versions.length }} 个版本</small>
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
  grid-template-columns: minmax(280px, 1fr) 220px auto;
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

.group-filter {
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
