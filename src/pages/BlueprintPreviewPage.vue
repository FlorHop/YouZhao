<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Drawer from 'primevue/drawer';
import Select from 'primevue/select';
import { useAppState } from '../state';

const route = useRoute();
const router = useRouter();
const app = useAppState();
const drawerVisible = ref(false);
const collapsed = ref(false);
const drawerWidth = ref(Math.round(window.innerWidth * 0.5));
const isResizingDrawer = ref(false);

const blueprint = computed(() => app.state.demos.find((demo) => demo.id === route.params.id));
const availableVersions = computed(() => blueprint.value?.versions.filter((version) => version.status === 'available') ?? []);
const selectedVersionId = ref('');

watch(
  blueprint,
  (current) => {
    if (!current) return;
    const versionFromQuery = String(route.query.version ?? '');
    const matched = current.versions.find((version) => version.version === versionFromQuery && version.status === 'available');
    selectedVersionId.value = matched?.id ?? current.versions.find((version) => version.isLatest)?.id ?? current.versions[0]?.id ?? '';
  },
  { immediate: true }
);

const selectedVersion = computed(() =>
  blueprint.value?.versions.find((version) => version.id === selectedVersionId.value)
);

function changeVersion(versionId: string) {
  const version = blueprint.value?.versions.find((item) => item.id === versionId);
  if (!blueprint.value || !version) return;
  selectedVersionId.value = versionId;
  router.replace({
    path: `/blueprints/${blueprint.value.id}/preview`,
    query: { version: version.version }
  });
}

function startDrawerResize(event: MouseEvent) {
  isResizingDrawer.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', resizeDrawer);
  window.addEventListener('mouseup', stopDrawerResize);
  event.preventDefault();
}

function resizeDrawer(event: MouseEvent) {
  if (!isResizingDrawer.value) return;
  const minWidth = 360;
  const maxWidth = Math.round(window.innerWidth * 0.8);
  drawerWidth.value = Math.min(maxWidth, Math.max(minWidth, window.innerWidth - event.clientX));
}

function stopDrawerResize() {
  isResizingDrawer.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', resizeDrawer);
  window.removeEventListener('mouseup', stopDrawerResize);
}

onBeforeUnmount(stopDrawerResize);
</script>

<template>
  <main v-if="blueprint && selectedVersion" class="preview-page">
    <iframe class="preview-frame" :src="selectedVersion.artifactUrl" :title="`${blueprint.name} ${selectedVersion.version}`" />

    <section class="floating-blueprint-card" :class="{ collapsed }">
      <button class="floating-toggle" type="button" @click="collapsed = !collapsed">
        <i :class="collapsed ? 'pi pi-angle-up' : 'pi pi-angle-down'" />
      </button>

      <template v-if="!collapsed">
        <div class="floating-head">
          <div>
            <strong>{{ blueprint.name }}</strong>
            <span>蓝图预览</span>
          </div>
        </div>
        <div class="floating-version">
          <span>版本</span>
          <Select
            :modelValue="selectedVersionId"
            :options="availableVersions"
            optionLabel="version"
            optionValue="id"
            class="floating-select"
            @update:modelValue="changeVersion"
          />
        </div>
        <Button
          label="文本内容"
          icon="pi pi-file"
          size="small"
          severity="secondary"
          outlined
          @click="drawerVisible = true"
        />
      </template>

      <template v-else>
        <div class="collapsed-card">
          <i class="pi pi-window-maximize" />
          <span>{{ selectedVersion.version }}</span>
        </div>
      </template>
    </section>

    <Drawer
      v-model:visible="drawerVisible"
      header="蓝图文本内容"
      position="right"
      class="markdown-drawer"
      :style="{ width: `${drawerWidth}px` }"
    >
      <div class="drawer-resizer" @mousedown="startDrawerResize" />
      <article class="markdown-content">
        <pre>{{ selectedVersion.markdown }}</pre>
      </article>
    </Drawer>
  </main>

  <div v-else class="denied-state">蓝图或版本不存在</div>
</template>

<style scoped>
.preview-page {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #111827;
}

.preview-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}

.floating-blueprint-card {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 20;
  display: grid;
  width: 246px;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(215, 221, 225, 0.88);
  border-radius: 8px;
  background: rgba(251, 252, 252, 0.94);
  box-shadow: 0 10px 28px rgba(41, 52, 61, 0.16);
  backdrop-filter: blur(10px);
}

.floating-blueprint-card.collapsed {
  width: auto;
  padding: 8px 10px;
}

.floating-toggle {
  position: absolute;
  top: -13px;
  right: 8px;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-muted);
  background: var(--app-panel);
  cursor: pointer;
}

.floating-head strong,
.floating-head span,
.floating-version span {
  display: block;
}

.floating-head strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.floating-head span,
.floating-version span {
  color: var(--app-muted);
  font-size: 12px;
}

.floating-version {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.floating-select {
  width: 132px;
}

.collapsed-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text);
  font-size: 13px;
}

.markdown-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--app-text);
  font-family: "PingFang SC", system-ui, sans-serif;
  line-height: 1.7;
}

.markdown-drawer :deep(.p-drawer-content) {
  position: relative;
  padding: 0;
}

.drawer-resizer {
  position: absolute;
  z-index: 2;
  top: 0;
  left: -4px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
}

.drawer-resizer:hover {
  background: rgba(101, 127, 144, 0.18);
}

.markdown-content {
  height: 100%;
  padding: 18px 20px;
  overflow: auto;
}
</style>
