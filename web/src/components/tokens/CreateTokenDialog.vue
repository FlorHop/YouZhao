<script setup lang="ts">
/**
 * P6 新建 Token 对话框（docs/frontend-design.md §6 P6；docs/permission-design.md §3.4 权限矩阵、§6.3 接口契约）。
 *
 * 可见性依据（§3.4 MCP 令牌权限矩阵）：
 * - 「创建 Token」入口对所有身份开放：矩阵「创建自己的只读 Token：允许（所有者/用户管理员/普通用户）」。
 * - `publish:blueprint` 在操作者不具备 `blueprint.publish` 时禁用（并给出说明）：矩阵
 *   「创建自己的发布 Token：所有者允许；用户管理员/普通用户受限，需具备 blueprint.publish」。
 *   平台所有者的 `hasCapability()` 在 session store 里恒为 true，因此所有者始终可选。
 * - 「绑定用户」选择器仅平台所有者渲染，且默认自己：矩阵「替他人创建 Token：仅所有者允许（须显式指定绑定用户）」。
 *
 * 明文（`yz_mcp_<id>_<secret>`）不进入本组件：创建成功后只上抛结果，由父级交给一次性面板展示。
 * 依据 §5.7「一次性信息只展示一次，关闭后不可再取回」与 §5.6「明细只展示一次，离开页面即丢弃」。
 */
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import DatePicker from 'primevue/datepicker';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import RadioButton from 'primevue/radiobutton';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import StateBlock from '@/components/common/StateBlock.vue';
import { ApiError } from '@/services/api';
import { createToken, listUsers } from '@/services/endpoints';
import type { TokenRow, TokenScope, UserRow } from '@/services/endpoints';
import { formatDate } from '@/services/format';
import { useSessionStore } from '@/stores/session';

const props = defineProps<{
  visible: boolean;
  /** 操作者是否为平台所有者（决定是否渲染「绑定用户」）。 */
  isOwner: boolean;
  /** 操作者是否具备 blueprint.publish（决定发布 scope 是否可选）。 */
  canPublish: boolean;
  /** 操作者本人 id：绑定用户默认值，也是「是否替他人创建」的判定基准。 */
  selfUserId: string;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 创建成功：明文只在这一次上抛给父级的一次性面板。 */
  created: [token: TokenRow & { token: string }];
}>();

type Validity = 'never' | '30' | '90' | 'custom';

const VALIDITY_OPTIONS: readonly { value: Validity; label: string }[] = [
  { value: 'never', label: '永不过期' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: 'custom', label: '自定义日期' },
];

const USERS_PAGE_SIZE = 100;

const name = ref('');
const readScope = ref(true);
const publishScope = ref(false);
const validity = ref<Validity>('never');
const customDate = ref<Date | null>(null);
const boundUserId = ref('');
const submitting = ref(false);
const formError = ref('');
const fieldErrors = ref<Record<string, string>>({});

const users = ref<UserRow[]>([]);
const usersState = ref<'loading' | 'error' | 'ready'>('loading');
const usersError = ref('');

const session = useSessionStore();

/**
 * 发布 scope 的「生效范围」（设计 §6 P6：`发布` 仅在具备发布能力时可选并显示生效范围）。
 * 范围来自 session store 的能力清单；替他人创建时无法在这里枚举对方的能力，
 * 因此只做机制说明——真正的判定在服务端（写工具仍要过平台策略）。
 */
const publishScopeHint = computed<string>(() => {
  if (props.isOwner) {
    return boundUserId.value === props.selfUserId
      ? '你是平台所有者，发布范围覆盖全部资源。'
      : '生效范围取决于被绑定用户当下的权限：他必须具备 blueprint.manage 且目标蓝图在其管理范围内，否则服务端返回 FORBIDDEN。';
  }
  const targets = session.capabilities.filter((item) => item.capability === 'blueprint.publish');
  if (targets.length === 0) {
    return '你当前没有蓝图发布能力，这把 Token 的写操作会在服务端被拒绝。';
  }
  const groups = targets.filter((item) => item.targetType === 'group').length;
  const blueprints = targets.filter((item) => item.targetType === 'blueprint').length;
  return `你的生效范围：${groups} 个分组、${blueprints} 个蓝图（以权限页为准）；目标超出该范围时服务端返回 FORBIDDEN。`;
});

const userOptions = computed(() =>
  users.value.map((user) => ({ label: `${user.displayName}（${user.username}）`, value: user.id })),
);

/** 只读恒可选（契约 minItems ≥ 1）；发布需要操作者自身具备 blueprint.publish。 */
const scopes = computed<TokenScope[]>(() => {
  const list: TokenScope[] = [];
  if (readScope.value) list.push('read:blueprint');
  if (publishScope.value && props.canPublish) list.push('publish:blueprint');
  return list;
});

/** 过期时刻取所选日期的本地 23:59:59——「30 天」= 从今天起第 30 天当天结束前有效。 */
function endOfLocalDay(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

const expiresAt = computed<string | undefined>(() => {
  if (validity.value === 'never') return undefined;
  if (validity.value === 'custom') {
    return customDate.value === null ? undefined : endOfLocalDay(customDate.value);
  }
  return endOfLocalDay(addDays(new Date(), Number(validity.value)));
});

const validityHint = computed<string>(() => {
  const value = expiresAt.value;
  if (value === undefined) {
    return '永不过期的 Token 不会因时间失效；仍可随时在列表里停用或删除。';
  }
  return `到期时间：${formatDate(value)}（当天 23:59 前有效）。到期后 Token 立即失效，用到它的客户端会收到 401。`;
});

async function loadUsers(): Promise<void> {
  if (!props.isOwner) return;
  usersState.value = 'loading';
  usersError.value = '';
  try {
    const envelope = await listUsers({ pageSize: USERS_PAGE_SIZE });
    users.value = envelope.data.items;
    usersState.value = 'ready';
  } catch (caught) {
    usersError.value =
      caught instanceof ApiError ? caught.message : '无法加载用户列表，请检查网络后重试。';
    usersState.value = 'error';
  }
}

function reset(): void {
  name.value = '';
  readScope.value = true;
  publishScope.value = false;
  validity.value = 'never';
  customDate.value = null;
  boundUserId.value = props.selfUserId;
  submitting.value = false;
  formError.value = '';
  fieldErrors.value = {};
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    reset();
    void loadUsers();
  },
);

function close(): void {
  emit('update:visible', false);
}

async function submit(): Promise<void> {
  if (name.value.trim() === '') {
    fieldErrors.value = { name: '请填写 Token 名称。' };
    return;
  }
  if (scopes.value.length === 0) {
    formError.value = '至少选择一项能力：只读或发布。';
    return;
  }
  if (validity.value === 'custom' && customDate.value === null) {
    formError.value = '请选择过期日期，或改选其他有效期。';
    return;
  }

  submitting.value = true;
  formError.value = '';
  fieldErrors.value = {};
  try {
    const result = await createToken({
      name: name.value.trim(),
      scopes: scopes.value,
      expiresAt: expiresAt.value,
      // 仅平台所有者、且确实替他人创建时才带上（契约：其他身份传 bindUserId 会被拒绝）。
      bindUserId:
        props.isOwner && boundUserId.value !== props.selfUserId ? boundUserId.value : undefined,
    });
    emit('created', result.data);
    close();
  } catch (caught) {
    if (caught instanceof ApiError) {
      fieldErrors.value = caught.fieldErrors;
      formError.value = caught.isAuthError
        ? '会话已过期，请重新登录后再创建 Token。'
        : caught.isForbidden
          ? '当前身份不能创建这把 Token：发布 scope 需要你自己具备 blueprint.publish，替他人创建需要平台所有者。'
          : caught.message;
    } else {
      formError.value = '创建失败，请重试。';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    header="新建 Token"
    :style="{ width: '34rem' }"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="form-grid" @submit.prevent="submit">
      <p class="caption">
        Token 的实际能力 = 绑定用户的平台权限 ∩ Token 自身的 scope，不会获得超出绑定用户的能力。
      </p>

      <div class="form-field">
        <label for="token-name">名称</label>
        <InputText
          id="token-name"
          v-model="name"
          autocomplete="off"
          :disabled="submitting"
          placeholder="例如：本机 Claude Code"
        />
        <p v-if="fieldErrors.name !== undefined" class="field-error">{{ fieldErrors.name }}</p>
        <p v-else class="hint">1–80 个字符，用来在列表里认出这把 Token。</p>
      </div>

      <fieldset class="form-field scope-fieldset">
        <legend>能力（scope）</legend>
        <div class="scope-option">
          <Checkbox
            v-model="readScope"
            :binary="true"
            input-id="token-scope-read"
            :disabled="submitting"
          />
          <div>
            <label for="token-scope-read">只读（read:blueprint）</label>
            <p class="hint">
              列出分组、蓝图与已发布版本，读取蓝图产物。不含任何写工具——服务端按 scope
              裁剪 tools/list，只读 Token 在客户端里看不到写工具。
            </p>
          </div>
        </div>
        <div class="scope-option">
          <Checkbox
            v-model="publishScope"
            :binary="true"
            input-id="token-scope-publish"
            :disabled="submitting || !canPublish"
          />
          <div>
            <label for="token-scope-publish">发布（publish:blueprint）</label>
            <p v-if="canPublish" class="hint">
              发布、覆盖、删除版本与创建分组。发布 scope 不含读取，通常和只读一起勾选（否则客户端连蓝图列表都拿不到）。
            </p>
            <p v-if="canPublish" class="hint">{{ publishScopeHint }}</p>
            <p v-else class="hint text-warn">
              你没有 blueprint.publish，无法创建发布 Token；需要时请平台所有者授予。
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset class="form-field validity-fieldset">
        <legend>有效期</legend>
        <div class="validity-options">
          <span v-for="option in VALIDITY_OPTIONS" :key="option.value" class="validity-option">
            <RadioButton
              v-model="validity"
              :value="option.value"
              :input-id="`token-validity-${option.value}`"
              :disabled="submitting"
            />
            <label :for="`token-validity-${option.value}`">{{ option.label }}</label>
          </span>
        </div>
        <DatePicker
          v-if="validity === 'custom'"
          v-model="customDate"
          date-format="yy-mm-dd"
          show-icon
          :disabled="submitting"
          placeholder="选择过期日期"
        />
        <p class="hint">{{ validityHint }}</p>
      </fieldset>

      <div v-if="isOwner" class="form-field">
        <label for="token-bound-user">绑定用户</label>
        <StateBlock
          v-if="usersState === 'loading'"
          state="loading"
        />
        <StateBlock
          v-else-if="usersState === 'error'"
          state="error"
          :description="usersError"
          @retry="loadUsers"
        />
        <Select
          v-else
          v-model="boundUserId"
          input-id="token-bound-user"
          :options="userOptions"
          option-label="label"
          option-value="value"
          filter
          :disabled="submitting"
          placeholder="选择绑定用户"
        />
        <p class="hint">
          默认绑定你自己。只有平台所有者可以为其他用户创建 Token，且必须在这里显式指定；该 Token
          的能力完全取决于被绑定用户当时的权限。
        </p>
      </div>

      <p v-if="formError !== ''" class="field-error" role="alert">{{ formError }}</p>
    </form>

    <template #footer>
      <div class="dialog-footer">
        <Button label="取消" severity="secondary" outlined :disabled="submitting" @click="close" />
        <Button label="创建 Token" type="button" :loading="submitting" @click="submit" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.form-grid {
  display: grid;
  gap: var(--space-5);
}

.form-field {
  display: grid;
  gap: var(--space-2);
}

.form-field > label,
.form-field > legend {
  padding: 0;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg-2);
}

.scope-fieldset,
.validity-fieldset {
  min-width: 0;
  margin: 0;
  border: 0;
}

.hint {
  margin: 0;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--muted);
}

.scope-option {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.scope-option + .scope-option {
  margin-top: var(--space-3);
}

.scope-option > div {
  display: grid;
  gap: var(--space-1);
}

.scope-option label {
  font-size: var(--text-sm);
  color: var(--fg);
}

.validity-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.validity-option {
  display: inline-flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--text-sm);
}

.dialog-footer {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
}
</style>
