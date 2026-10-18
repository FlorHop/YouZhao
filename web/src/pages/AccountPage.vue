<script setup lang="ts">
/**
 * P8 · 我的账号（docs/frontend-design.md §6 P8、§3、§7、§9）。
 *
 * - 入口：冻结的 `App.vue` 顶栏头像菜单里的「我的账号」；设计明确本页**不进主导航**，
 *   因此这里**不再渲染任何导航**（壳由 AppShell 提供，router.ts 里本路由没有 `meta.bare`）。
 * - 只呈现本人信息：不含用户列表、授权配置或任何他人数据；普通用户在本页看不到任何管理入口，
 *   也不能从本页进入 `用户` / `权限`（设计 §4、P8）。
 * - 区段与文案取自 P8：`账号资料`（用户名只读 + 姓名/邮箱/手机号）、`修改密码`、
 *   `我的身份与范围`（只读：身份标签、能力与资源范围、获授的查看范围并按来源标注 = 授予人）、`退出登录`。
 * - §7 权限可视化：只读项 = 纯文本 + 授予者与时间，无勾选框；越权不可用 = 不渲染入口。
 *
 * 身份与范围全部来自 `useSessionStore()`（architecture-design §5.6：session store 是权限 UI 判断的唯一来源）。
 */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import InputText from 'primevue/inputtext';
import { useToast } from 'primevue/usetoast';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import PageHeader from '@/components/common/PageHeader.vue';
import StateBlock from '@/components/common/StateBlock.vue';
import { ApiError } from '@/services/api';
import { changeMyPassword, updateMe } from '@/services/endpoints';
import type { TargetType } from '@/services/endpoints';
import { formatDateTime } from '@/services/format';
import { capabilityLabel, identityLabel, useSessionStore } from '@/stores/session';

/** 契约里的范围类型只有两种（permission-design §2.3）。 */
const TARGET_LABELS: Record<TargetType, string> = {
  group: '分组',
  blueprint: '蓝图',
};

const MIN_PASSWORD_LENGTH = 8;
const PAGE_SIZE = 20;

const session = useSessionStore();
const toast = useToast();
const router = useRouter();

const identityText = computed(() =>
  session.identity === null ? '未知' : identityLabel(session.identity),
);

/** `我的查看范围`：只读展示 + 授予人（§7「纯文本 + 授予者与时间」）。 */
const grantRows = computed(() =>
  session.viewGrants.map((grant) => ({
    key: `${grant.targetType}:${grant.targetId}`,
    scope: TARGET_LABELS[grant.targetType],
    resourceId: grant.targetId,
    grantedBy: grant.grantedByDisplayName,
    grantedAt: formatDateTime(grant.grantedAt),
  })),
);

/** `我的能力`：能力名 + 资源范围（用户管理员/普通用户来自 capabilities；所有者另作说明）。 */
const capabilityRows = computed(() =>
  session.capabilities.map((item) => ({
    key: `${item.capability}:${item.targetType}:${item.targetId}`,
    capability: capabilityLabel(item.capability),
    scope: TARGET_LABELS[item.targetType],
    resourceId: item.targetId,
  })),
);

/** 用户管理员的「可委派范围」：等于其本人被授予的查看范围，不单独维护（permission-design §2.3）。 */
const delegableRows = computed(() =>
  session.delegableScopes.map((scope) => ({
    key: `${scope.targetType}:${scope.targetId}`,
    scope: TARGET_LABELS[scope.targetType],
    resourceId: scope.targetId,
  })),
);

const grantEmptyDescription = computed(() =>
  session.isOwner
    ? '你是平台所有者，不需要逐条授予查看范围即可查看全部蓝图。'
    : '你还没有被授予任何蓝图范围。需要时请联系授予人（平台所有者或你的用户管理员）。',
);

// ── 账号资料 ──────────────────────────────────────────────────────────────

const username = computed(() => session.user?.username ?? '');
const displayName = ref('');
const email = ref('');
const phone = ref('');
const profileSubmitting = ref(false);
const profileError = ref('');
const profileFieldErrors = ref<Record<string, string>>({});

watch(
  () => session.user,
  (user) => {
    if (user === null) return;
    displayName.value = user.displayName;
    email.value = user.email ?? '';
    phone.value = user.phone ?? '';
  },
  { immediate: true },
);

/** 统一的字段级错误展示（§7 表单：错误显示在字段附近）。 */
function describeError(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (caught.isAuthError) return '会话已过期，请重新登录后再试。';
    return caught.message;
  }
  return fallback;
}

async function saveProfile(): Promise<void> {
  if (displayName.value.trim() === '') {
    profileFieldErrors.value = { displayName: '姓名不能为空。' };
    return;
  }
  profileSubmitting.value = true;
  profileError.value = '';
  profileFieldErrors.value = {};
  const mail = email.value.trim();
  const tel = phone.value.trim();
  try {
    // 契约（schemas/me/update.json）：email / phone 是 string 且「可留空字符串」，清空即传空串。
    const data = await updateMe({
      displayName: displayName.value.trim(),
      email: mail,
      phone: tel,
    });
    session.apply(data);
    toast.add({
      severity: 'success',
      summary: '资料已保存',
      detail: '姓名、邮箱与手机号已更新。',
      life: 3000,
    });
  } catch (caught) {
    if (caught instanceof ApiError) {
      profileFieldErrors.value = caught.fieldErrors;
      profileError.value = caught.isAuthError
        ? '会话已过期，请重新登录后再试。'
        : describeError(caught, '保存失败，请重试。');
    } else {
      profileError.value = '保存失败，请重试。';
    }
  } finally {
    profileSubmitting.value = false;
  }
}

// ── 修改密码 ──────────────────────────────────────────────────────────────

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordSubmitting = ref(false);
const passwordError = ref('');
const passwordFieldErrors = ref<Record<string, string>>({});

async function submitPassword(): Promise<void> {
  if (currentPassword.value === '') {
    passwordFieldErrors.value = { oldPassword: '请输入当前密码。' };
    return;
  }
  if (newPassword.value.length < MIN_PASSWORD_LENGTH) {
    passwordFieldErrors.value = { newPassword: `新密码至少 ${MIN_PASSWORD_LENGTH} 位。` };
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordFieldErrors.value = { confirmPassword: '两次输入的新密码不一致。' };
    return;
  }

  passwordSubmitting.value = true;
  passwordError.value = '';
  passwordFieldErrors.value = {};
  try {
    await changeMyPassword({
      oldPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    toast.add({
      severity: 'success',
      summary: '密码已修改',
      detail: '当前会话保持登录；下次登录请使用新密码。',
      life: 4000,
    });
  } catch (caught) {
    if (caught instanceof ApiError) {
      passwordFieldErrors.value = caught.fieldErrors;
      if (caught.isAuthError) {
        passwordError.value = '会话已过期，请重新登录后再试。';
      } else if (Object.keys(caught.fieldErrors).length === 0) {
        passwordError.value =
          caught.status === 400 || caught.status === 401
            ? '当前密码不正确，请重新输入。'
            : describeError(caught, '修改密码失败，请重试。');
      } else {
        passwordError.value = caught.message;
      }
    } else {
      passwordError.value = '修改密码失败，请重试。';
    }
  } finally {
    passwordSubmitting.value = false;
  }
}

// ── 退出登录 ──────────────────────────────────────────────────────────────

const signingOut = ref(false);

async function signOut(): Promise<void> {
  signingOut.value = true;
  try {
    await session.signOut();
    await router.push({ name: 'login' });
  } catch {
    toast.add({
      severity: 'error',
      summary: '退出登录未完成',
      detail: '无法连接服务端，本地登录状态已清除；服务端会话可能仍然有效。',
      life: 5000,
    });
    await router.push({ name: 'login' });
  } finally {
    signingOut.value = false;
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="我的账号"
      lede="这里只显示你自己的资料、身份与范围。任何授权调整都由有权限的人在权限页完成，本页不可编辑范围。"
    />

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">账号资料</h2>
      </div>

      <form class="form-grid" @submit.prevent="saveProfile">
        <div class="form-field">
          <label for="account-username">用户名</label>
          <p id="account-username" class="readonly-value mono">{{ username }}</p>
          <p class="hint">用户名是登录凭据，创建后不可修改。</p>
        </div>

        <div class="form-field">
          <label for="account-display-name">姓名</label>
          <InputText
            id="account-display-name"
            v-model="displayName"
            :disabled="profileSubmitting"
            autocomplete="name"
          />
          <p v-if="profileFieldErrors.displayName !== undefined" class="field-error">
            {{ profileFieldErrors.displayName }}
          </p>
        </div>

        <div class="form-field">
          <label for="account-email">邮箱</label>
          <InputText
            id="account-email"
            v-model="email"
            type="email"
            :disabled="profileSubmitting"
            autocomplete="email"
          />
          <p v-if="profileFieldErrors.email !== undefined" class="field-error">
            {{ profileFieldErrors.email }}
          </p>
          <p v-else class="hint">留空表示清空邮箱。</p>
        </div>

        <div class="form-field">
          <label for="account-phone">手机号</label>
          <InputText
            id="account-phone"
            v-model="phone"
            type="tel"
            :disabled="profileSubmitting"
            autocomplete="tel"
          />
          <p v-if="profileFieldErrors.phone !== undefined" class="field-error">
            {{ profileFieldErrors.phone }}
          </p>
          <p v-else class="hint">留空表示清空手机号。</p>
        </div>

        <p v-if="profileError !== ''" class="field-error" role="alert">{{ profileError }}</p>

        <div class="form-actions">
          <Button type="submit" label="保存资料" :loading="profileSubmitting" />
        </div>
      </form>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">修改密码</h2>
      </div>

      <form class="form-grid" @submit.prevent="submitPassword">
        <div class="form-field">
          <label for="account-current-password">当前密码</label>
          <InputText
            id="account-current-password"
            v-model="currentPassword"
            type="password"
            :disabled="passwordSubmitting"
            autocomplete="current-password"
          />
          <p v-if="passwordFieldErrors.oldPassword !== undefined" class="field-error">
            {{ passwordFieldErrors.oldPassword }}
          </p>
        </div>

        <div class="form-field">
          <label for="account-new-password">新密码</label>
          <InputText
            id="account-new-password"
            v-model="newPassword"
            type="password"
            :disabled="passwordSubmitting"
            autocomplete="new-password"
          />
          <p v-if="passwordFieldErrors.newPassword !== undefined" class="field-error">
            {{ passwordFieldErrors.newPassword }}
          </p>
          <p v-else class="hint">至少 {{ MIN_PASSWORD_LENGTH }} 位。</p>
        </div>

        <div class="form-field">
          <label for="account-confirm-password">确认新密码</label>
          <InputText
            id="account-confirm-password"
            v-model="confirmPassword"
            type="password"
            :disabled="passwordSubmitting"
            autocomplete="new-password"
          />
          <p v-if="passwordFieldErrors.confirmPassword !== undefined" class="field-error">
            {{ passwordFieldErrors.confirmPassword }}
          </p>
        </div>

        <p v-if="passwordError !== ''" class="field-error" role="alert">{{ passwordError }}</p>

        <div class="form-actions">
          <Button
            type="submit"
            label="修改密码"
            severity="secondary"
            outlined
            :loading="passwordSubmitting"
          />
        </div>
      </form>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">我的身份与范围</h2>
        <p class="caption">以下内容只读：调整必须由有权限者在权限页进行。</p>
      </div>

      <p class="identity-line">
        身份：<span class="chip">{{ identityText }}</span>
      </p>

      <h3 class="sub-title">我的能力</h3>

      <p v-if="session.isOwner" class="caption">
        你是平台所有者：蓝图管理与蓝图发布覆盖全部资源，服务端对所有者跳过逐条范围校验。
      </p>
      <StateBlock
        v-else-if="capabilityRows.length === 0"
        state="empty"
        title="没有额外的业务能力"
        description="你目前只有查看权限。需要管理或发布蓝图时，请让平台所有者或你的用户管理员在权限页授予。"
      />
      <DataTable
        v-else
        :value="capabilityRows"
        data-key="key"
        size="small"
        :paginator="capabilityRows.length > PAGE_SIZE"
        :rows="PAGE_SIZE"
      >
        <Column field="capability" header="能力" />
        <Column field="scope" header="资源范围" />
        <Column field="resourceId" header="资源标识" />
      </DataTable>

      <h3 class="sub-title">我的查看范围</h3>
      <StateBlock
        v-if="grantRows.length === 0"
        state="empty"
        title="没有可见范围"
        :description="grantEmptyDescription"
      />
      <DataTable
        v-else
        :value="grantRows"
        data-key="key"
        size="small"
        :paginator="grantRows.length > PAGE_SIZE"
        :rows="PAGE_SIZE"
      >
        <Column field="scope" header="范围类型" />
        <Column field="resourceId" header="资源标识" />
        <Column field="grantedBy" header="授予人" />
        <Column field="grantedAt" header="授予时间" />
      </DataTable>

      <template v-if="session.isUserAdmin">
        <h3 class="sub-title">可委派范围</h3>
        <p class="caption">
          它不单独维护，恒等于你自己被授予的查看范围（见上表），决定你能为名下用户开放哪些蓝图；
          不包含蓝图管理与发布权。
        </p>
        <DataTable
          :value="delegableRows"
          data-key="key"
          size="small"
          :paginator="delegableRows.length > PAGE_SIZE"
          :rows="PAGE_SIZE"
        >
          <Column field="scope" header="范围类型" />
          <Column field="resourceId" header="资源标识" />
        </DataTable>
      </template>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">退出登录</h2>
        <p class="caption">退出后需要重新用用户名和密码登录；你的资料、范围与 Token 都不会变化。</p>
      </div>

      <div class="form-actions">
        <Button
          type="button"
          label="退出登录"
          severity="secondary"
          outlined
          :loading="signingOut"
          @click="signOut"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  gap: var(--space-4);
  max-width: 32rem;
}

.form-field {
  display: grid;
  gap: var(--space-2);
}

.form-field > label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg-2);
}

.form-actions {
  display: flex;
  gap: var(--space-3);
}

.readonly-value {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg);
}

.hint {
  margin: 0;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--muted);
}

.sub-title {
  margin: var(--space-6) 0 var(--space-3);
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--fg-2);
}

.identity-line {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg);
}
</style>
