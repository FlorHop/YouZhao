<script setup lang="ts">
/**
 * 区段「管辖」（仅平台所有者）。
 *
 * 管辖不是权限，是地盘：
 *   - 管辖一个分组 ⇒ 该组上获得 `blueprint.publish` + `blueprint.manage`（含组内全部蓝图）；
 *   - 管辖单个蓝图 ⇒ 只获得该蓝图的 `blueprint.manage`（不含「在该组内新建」）；
 *   - 保存是整体替换（`PUT /api/users/:id/jurisdiction`）。
 *
 * 只对「用户管理员」生效：普通用户的写权限走「业务能力」例外授权，
 * 所有者隐式全权，两者都不需要、也不允许在这里划地盘。
 */
import { computed, ref, watch } from 'vue';

import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';

import * as api from '@/services/endpoints';
import type { UserAccessData } from '@/services/endpoints';

interface AdminRow {
  id: string;
  displayName: string;
  username: string;
}

interface GroupOption {
  id: string;
  name: string;
}

interface BlueprintOption {
  id: string;
  name: string;
  groupId: string;
}

const props = defineProps<{
  admins: AdminRow[];
  groups: GroupOption[];
  blueprints: BlueprintOption[];
}>();

const accessById = ref<Record<string, UserAccessData>>({});
const loading = ref(false);
const loadError = ref('');

const dialogVisible = ref(false);
const currentAdmin = ref<AdminRow | null>(null);
const selectedGroups = ref<string[]>([]);
const selectedBlueprints = ref<string[]>([]);
const saving = ref(false);
const saveError = ref('');

const groupNameById = computed(() => new Map(props.groups.map((group) => [group.id, group.name])));

const rows = computed(() =>
  props.admins.map((admin) => {
    const access = accessById.value[admin.id];
    const jurisdiction = access?.jurisdiction;
    return {
      id: admin.id,
      displayName: admin.displayName,
      username: admin.username,
      summary:
        jurisdiction === undefined
          ? '读取中…'
          : jurisdiction.groups.length === 0 && jurisdiction.blueprints.length === 0
            ? '尚未划拨管辖'
            : [
                jurisdiction.groups.length > 0
                  ? `分组：${jurisdiction.groups.map((group) => group.name).join('、')}`
                  : '',
                jurisdiction.blueprints.length > 0
                  ? `蓝图：${jurisdiction.blueprints.map((item) => item.name).join('、')}`
                  : '',
              ]
                .filter((part) => part !== '')
                .join('；'),
    };
  }),
);

async function loadAccess(): Promise<void> {
  if (props.admins.length === 0) {
    accessById.value = {};
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    const results = await Promise.all(
      props.admins.map(async (admin) => [admin.id, await api.getUserAccess(admin.id)] as const),
    );
    accessById.value = Object.fromEntries(results);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '管辖范围读取失败';
  } finally {
    loading.value = false;
  }
}

watch(() => props.admins, loadAccess, { immediate: true });

async function openDialog(admin: AdminRow): Promise<void> {
  currentAdmin.value = admin;
  saveError.value = '';
  selectedGroups.value = [];
  selectedBlueprints.value = [];
  dialogVisible.value = true;
  try {
    const access = accessById.value[admin.id] ?? (await api.getUserAccess(admin.id));
    accessById.value = { ...accessById.value, [admin.id]: access };
    selectedGroups.value = access.jurisdiction.groups.map((group) => group.id);
    selectedBlueprints.value = access.jurisdiction.blueprints.map((item) => item.id);
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : '管辖范围读取失败';
  }
}

function toggle(list: 'group' | 'blueprint', id: string, checked: boolean): void {
  const target = list === 'group' ? selectedGroups : selectedBlueprints;
  target.value = checked
    ? [...target.value.filter((item) => item !== id), id]
    : target.value.filter((item) => item !== id);
}

async function save(): Promise<void> {
  const admin = currentAdmin.value;
  if (admin === null) return;
  saving.value = true;
  saveError.value = '';
  try {
    const jurisdiction = await api.setUserJurisdiction(admin.id, {
      groupIds: selectedGroups.value,
      blueprintIds: selectedBlueprints.value,
    });
    const previous = accessById.value[admin.id];
    if (previous !== undefined) {
      accessById.value = {
        ...accessById.value,
        [admin.id]: { ...previous, jurisdiction },
      };
    } else {
      await loadAccess();
    }
    dialogVisible.value = false;
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : '管辖范围保存失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="section">
    <div class="section-head">
      <div>
        <h2 class="section-title">管辖范围</h2>
        <p class="caption">
          管辖是「地盘」：管辖一个分组即可在该分组下新建蓝图、维护组内全部蓝图，并自动可见；
          管辖单个蓝图只给该蓝图的维护权（不含新建）。只想让人维护、不想让人发版时，
          不要划管辖，改用下方「业务能力」只勾「蓝图管理」。
        </p>
      </div>
      <span class="toolbar-spacer" />
      <Button label="刷新" icon="pi pi-refresh" text :loading="loading" @click="loadAccess" />
    </div>

    <p v-if="loadError !== ''" class="error-text">{{ loadError }}</p>

    <DataTable :value="rows" data-key="id" table-style="min-width: 48rem">
      <Column field="displayName" header="用户管理员">
        <template #body="{ data }">
          <span>{{ data.displayName }}</span>
          <span class="meta">（{{ data.username }}）</span>
        </template>
      </Column>
      <Column field="summary" header="管辖范围">
        <template #body="{ data }">
          <span class="scope-text">{{ data.summary }}</span>
        </template>
      </Column>
      <Column header="操作" style="width: 9rem">
        <template #body="{ data }">
          <Button label="设置管辖" size="small" text @click="openDialog(data)" />
        </template>
      </Column>

      <template #empty>
        <p class="caption">还没有用户管理员；先在下方「用户管理员」区段任命一位。</p>
      </template>
    </DataTable>

    <Dialog
      v-model:visible="dialogVisible"
      modal
      :header="`设置管辖 · ${currentAdmin?.displayName ?? ''}`"
      :style="{ width: '44rem', maxWidth: '94vw' }"
      :draggable="false"
    >
      <div class="dialog-body">
        <section>
          <h3 class="group-title">分组管辖</h3>
          <p class="caption">
            勾选后，该管理员可在这些分组下新建蓝图、维护组内全部蓝图，并自动看到这些分组。
          </p>
          <div class="check-grid">
            <label v-for="group in props.groups" :key="group.id" class="check-row">
              <Checkbox
                binary
                :model-value="selectedGroups.includes(group.id)"
                @update:model-value="(value: boolean) => toggle('group', group.id, value)"
              />
              <span>{{ group.name }}</span>
            </label>
          </div>
          <p v-if="props.groups.length === 0" class="caption">还没有分组。</p>
        </section>

        <section>
          <h3 class="group-title">单蓝图管辖</h3>
          <p class="caption">
            只授予指定蓝图的维护权（不含在该分组下新建蓝图）。适合「借一位管理员照看某几张图」。
          </p>
          <div class="check-grid">
            <label v-for="blueprint in props.blueprints" :key="blueprint.id" class="check-row">
              <Checkbox
                binary
                :model-value="selectedBlueprints.includes(blueprint.id)"
                @update:model-value="(value: boolean) => toggle('blueprint', blueprint.id, value)"
              />
              <span>
                <span class="meta">{{ groupNameById.get(blueprint.groupId) ?? '（未知分组）' }} /</span>
                {{ blueprint.name }}
              </span>
            </label>
          </div>
          <p v-if="props.blueprints.length === 0" class="caption">还没有蓝图。</p>
        </section>

        <p v-if="saveError !== ''" class="error-text">{{ saveError }}</p>
        <p class="caption">
          保存会整体替换该管理员的管辖范围；不改变其查看授权与例外能力。
        </p>
      </div>

      <template #footer>
        <Button label="取消" text :disabled="saving" @click="dialogVisible = false" />
        <Button label="保存" icon="pi pi-check" :loading="saving" @click="save" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.group-title {
  margin: 0 0 var(--space-2);
  font-size: 0.95rem;
  font-weight: 600;
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: var(--space-2);
  max-height: 15rem;
  overflow-y: auto;
  margin-top: var(--space-2);
}

.check-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: 0.9rem;
}

.scope-text {
  color: var(--app-text);
  line-height: 1.5;
}

.error-text {
  color: var(--app-danger);
  font-size: 0.875rem;
}
</style>
