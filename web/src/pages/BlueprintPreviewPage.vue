<script setup lang="ts">
/**
 * P3 预览页（`/blueprints/:id/preview`，frontend-design §P3）。
 *
 * 全屏、只读：不提供任何编辑/发布/权限入口。产物在 iframe 里渲染，iframe 必须设置
 * `sandbox` 且**不授予同源能力**，因此产物既读不到会话凭证，也读不到宿主页面。
 * iframe 的地址只能来自服务端签发的票据（`issuePreviewTicket`），前端不拼接预览地址。
 *
 * 票据是一次性的、默认 60 秒有效。用户长时间挂在这个页面上再切换回来时，票据可能已经
 * 过期，所以这里在加载超时时会自动换一张新票重试一次，避免把一张过期票据的原始报错
 * 暴露给用户；只有在重试后仍然失败时才显示「票据过期」并让用户手动重试。
 */
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useToast } from 'primevue/usetoast';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/services/api';
import { getBlueprint, issuePreviewTicket } from '@/services/endpoints';
import type { BlueprintVersion } from '@/services/endpoints';
import { useSessionStore } from '@/stores/session';

/** 详情接口的返回体（{ blueprint, versions, capabilities }）。 */
type BlueprintDetailData = Awaited<ReturnType<typeof getBlueprint>>;

const props = defineProps<{ id: string }>();

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const toast = useToast();

const FRAME_LOAD_TIMEOUT_MS = 20000;
/** 票据默认 60 秒有效；离开这么久之后再回来就先换一张新票。 */
const TICKET_STALE_MS = 45000;

type FailureKind =
  | 'no-permission'
  | 'blueprint-archived'
  | 'version-missing'
  | 'artifact-missing'
  | 'ticket-expired'
  | 'load-timeout'
  | 'unknown';

interface FailureCopy {
  title: string;
  reason: string;
  next: string;
}

const FAILURES: Record<FailureKind, FailureCopy> = {
  'no-permission': {
    title: '没有查看权限',
    reason: '当前账号没有这个蓝图的查看权限，或者权限刚刚被撤销。',
    next: '返回蓝图列表可以看到你仍有权限查看的内容；如果这里本该有权限，请联系管理员重新分配查看范围。',
  },
  'blueprint-archived': {
    title: '蓝图已归档',
    reason: '这个蓝图已经被归档，归档的蓝图不提供预览。',
    next: '返回蓝图列表，在「已归档」视图里恢复它之后即可预览。',
  },
  'version-missing': {
    title: '版本不存在',
    reason: '要预览的版本不存在，或者已经被归档。',
    next: '改用其它可用版本，或返回蓝图列表重新选择。',
  },
  'artifact-missing': {
    title: '产物缺失',
    reason: '这个版本的产物在服务端已经缺失，没有可显示的内容。',
    next: '试试其它可用版本；如果所有版本都缺失，请联系发布者重新上传产物。',
  },
  'ticket-expired': {
    title: '票据已过期',
    reason: '预览票据是一次性的，有效期很短（默认 60 秒），这张票据可能已经被使用或已过期。',
    next: '点「重试」重新申请一张票据并重新加载。',
  },
  'load-timeout': {
    title: '加载超时',
    reason: '产物在预期时间内没有加载完成，可能是网络较慢、产物较大，或服务端暂时不可用。',
    next: '点「重试」再加载一次，或在新窗口打开排查。',
  },
  unknown: {
    title: '加载失败',
    reason: '请求没有成功返回，可能是网络中断或服务端暂时不可用。',
    next: '点「重试」重新加载；若持续失败，请稍后再试或联系管理员。',
  },
};

const detail = ref<BlueprintDetailData | null>(null);
const loadingDetail = ref(false);
const failureKind = ref<FailureKind | null>(null);
const failureHint = ref('');

const selectedVersion = ref('');
const frameSrc = ref('');
const frameLoading = ref(false);

let frameTimer: number | undefined;
let ticketIssuedAt = 0;
let autoRetried = false;
let previousBodyOverflow = '';

const blueprintName = computed(() => detail.value?.blueprint.name ?? '蓝图预览');
const availableVersions = computed<BlueprintVersion[]>(() =>
  (detail.value?.versions ?? []).filter((item) => item.archivedAt === null),
);
const showVersionPicker = computed(() => availableVersions.value.length > 1 && failureKind.value === null);
const versionOptions = computed(() =>
  availableVersions.value.map((item) => ({
    label: `v${item.version}${item.isLatest ? '（最新）' : ''}`,
    value: item.version,
  })),
);
const currentVersion = computed(() => {
  const version = selectedVersion.value;
  return version === '' ? '' : `v${version}`;
});
const failure = computed<FailureCopy | null>(() =>
  failureKind.value === null ? null : FAILURES[failureKind.value],
);

function clearFrameTimer(): void {
  if (frameTimer !== undefined) {
    window.clearTimeout(frameTimer);
    frameTimer = undefined;
  }
}

function pickVersionFromRoute(): string {
  const value = route.query.version;
  return typeof value === 'string' ? value : '';
}

function isForbidden(error: ApiError): boolean {
  return error.isForbidden || error.code === 'CAPABILITY_REQUIRED';
}

function classify(error: unknown): FailureKind {
  if (!(error instanceof ApiError)) return 'unknown';
  if (isForbidden(error)) return 'no-permission';
  if (error.code === 'BLUEPRINT_NOT_FOUND' || error.code === 'NOT_FOUND') return 'blueprint-archived';
  if (error.code === 'VERSION_NOT_FOUND') return 'version-missing';
  if (error.code === 'SERVICE_UNAVAILABLE') return 'unknown';
  return 'unknown';
}

function fail(kind: FailureKind, hint = ''): void {
  clearFrameTimer();
  failureKind.value = kind;
  failureHint.value = hint;
  frameLoading.value = false;
  frameSrc.value = '';
}

async function goToLogin(): Promise<void> {
  await session.load();
  await router.push({ name: 'login', query: { next: route.fullPath } });
}

async function handleError(error: unknown, fallback: FailureKind): Promise<void> {
  if (error instanceof ApiError && error.isAuthError) {
    await goToLogin();
    return;
  }
  const kind = classify(error);
  fail(kind === 'unknown' ? fallback : kind);
}

async function loadDetail(): Promise<void> {
  loadingDetail.value = true;
  failureKind.value = null;
  failureHint.value = '';
  try {
    const data = await getBlueprint(props.id);
    detail.value = data;
    if (data.blueprint.status === 'archived') {
      fail('blueprint-archived');
      return;
    }
    const wanted = selectedVersion.value === '' ? pickVersionFromRoute() : selectedVersion.value;
    const usable = data.versions.filter((item) => item.archivedAt === null);
    const chosen =
      (wanted !== '' ? usable.find((item) => item.version === wanted) : undefined) ??
      usable.find((item) => item.isLatest) ??
      usable[0];
    if (chosen === undefined) {
      // 一个可用版本都没有：不同于「版本不存在」，这里没有可切换的目标。
      fail('artifact-missing');
      return;
    }
    if (wanted !== '' && chosen.version !== wanted) {
      fail('version-missing');
      return;
    }
    selectedVersion.value = chosen.version;
    if (chosen.status === 'missing') {
      fail('artifact-missing');
      return;
    }
    await loadTicket();
  } catch (error) {
    await handleError(error, 'unknown');
  } finally {
    loadingDetail.value = false;
  }
}

async function loadTicket(): Promise<void> {
  if (selectedVersion.value === '') return;
  clearFrameTimer();
  failureKind.value = null;
  failureHint.value = '';
  frameLoading.value = true;
  try {
    const ticket = await issuePreviewTicket(props.id, selectedVersion.value);
    frameSrc.value = ticket.url;
    ticketIssuedAt = Date.now();
    frameTimer = window.setTimeout(() => {
      onFrameTimeout();
    }, FRAME_LOAD_TIMEOUT_MS);
  } catch (error) {
    await handleError(error, 'unknown');
  }
}

function onFrameTimeout(): void {
  frameTimer = undefined;
  if (!autoRetried) {
    // 最常见的原因是票据过期（页面挂久了、或切换标签页回来）：自动换一张新票重试一次。
    autoRetried = true;
    frameSrc.value = '';
    void loadTicket();
    return;
  }
  fail('load-timeout', '如果反复超时，可以在新窗口打开排查，或确认服务端预览域是否可达。');
}

function onFrameLoad(): void {
  clearFrameTimer();
  frameLoading.value = false;
}

async function retry(): Promise<void> {
  autoRetried = true;
  if (selectedVersion.value === '' || detail.value === null) {
    await loadDetail();
    return;
  }
  await loadTicket();
}

function onVersionSelect(version: string): void {
  if (version === selectedVersion.value) return;
  selectedVersion.value = version;
  autoRetried = false;
  void router.replace({ query: { ...route.query, version } });
  const target = availableVersions.value.find((item) => item.version === version);
  if (target !== undefined && target.status === 'missing') {
    fail('artifact-missing');
    return;
  }
  void loadTicket();
}

function switchToLatest(): void {
  const latest = availableVersions.value.find((item) => item.isLatest) ?? availableVersions.value[0];
  if (latest === undefined) return;
  onVersionSelect(latest.version);
}

function goBack(): void {
  void router.push({ name: 'blueprints' });
}

async function openInNewWindow(): Promise<void> {
  // 每次「在新窗口打开」都要换一张新票：`frameSrc` 里的票在 iframe 加载时就已经被服务端
  // 兑换掉了（票据单次使用），直接复用只会拿到 403「票据已被使用」。
  //
  // 开窗必须同步发生——await 之后再开会被浏览器当成非用户手势而拦截——所以先开空白页拿句柄。
  // 这里也不能带 `noopener`：带它时 window.open 返回 null，就拿不到句柄去导航；改为导航前后
  // 立刻断开 opener。
  const opened = window.open('about:blank', '_blank');
  if (opened === null) {
    toast.add({
      severity: 'warn',
      summary: '新窗口被拦截',
      detail: '请允许本站弹出窗口后重试，或直接在当前页查看预览。',
      life: 5000,
    });
    return;
  }
  opened.opener = null;
  try {
    const ticket = await issuePreviewTicket(props.id, selectedVersion.value);
    opened.location.replace(ticket.url);
  } catch (error) {
    opened.close();
    if (error instanceof ApiError && error.isAuthError) {
      await goToLogin();
      return;
    }
    toast.add({
      severity: 'error',
      summary: '打不开新窗口',
      detail: error instanceof ApiError ? error.message : '请求没有成功返回，请稍后重试。',
      life: 6000,
    });
  }
}

function reloadFrame(): void {
  void loadTicket();
}

function onWindowFocus(): void {
  if (frameSrc.value === '' || failureKind.value !== null) return;
  if (frameLoading.value) return;
  if (Date.now() - ticketIssuedAt < TICKET_STALE_MS) return;
  // 票据可能已经过期：静默换一张新票，用户看不到一次原始 403。
  autoRetried = false;
  void loadTicket();
}

watch(
  () => props.id,
  () => {
    detail.value = null;
    selectedVersion.value = pickVersionFromRoute();
    autoRetried = false;
    void loadDetail();
  },
);

watch(
  () => route.query.version,
  (value) => {
    if (typeof value !== 'string' || value === '' || value === selectedVersion.value) return;
    onVersionSelect(value);
  },
);

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  selectedVersion.value = pickVersionFromRoute();
  void loadDetail();
  window.addEventListener('focus', onWindowFocus);
});

onBeforeUnmount(() => {
  clearFrameTimer();
  window.removeEventListener('focus', onWindowFocus);
  document.body.style.overflow = previousBodyOverflow;
});
</script>

<template>
  <div class="preview-root">
    <div class="preview-toolbar">
      <Button
        icon="pi pi-arrow-left"
        text
        severity="secondary"
        aria-label="返回蓝图列表"
        title="返回蓝图列表"
        @click="goBack"
      />
      <span class="preview-title" :title="blueprintName">{{ blueprintName }}</span>
      <span v-if="currentVersion !== ''" class="chip is-muted">{{ currentVersion }}</span>

      <span class="toolbar-spacer" />

      <Select
        v-if="showVersionPicker"
        :model-value="selectedVersion"
        :options="versionOptions"
        option-label="label"
        option-value="value"
        aria-label="切换预览版本"
        @update:model-value="onVersionSelect"
      />
      <Button
        icon="pi pi-refresh"
        text
        severity="secondary"
        aria-label="重新加载预览"
        title="重新加载预览"
        :disabled="failureKind !== null && selectedVersion === ''"
        @click="reloadFrame"
      />
      <Button
        icon="pi pi-external-link"
        text
        severity="secondary"
        aria-label="在新窗口打开"
        title="在新窗口打开"
        @click="openInNewWindow"
      />
    </div>

    <div class="preview-body">
      <div v-if="loadingDetail || frameLoading" class="preview-overlay">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        <p class="caption">正在加载产物…</p>
      </div>

      <div v-else-if="failure !== null" class="preview-overlay preview-failure" role="alert">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <p class="section-title">{{ failure.title }}</p>
        <p class="caption preview-failure-text">{{ failure.reason }}</p>
        <p class="caption preview-failure-text">{{ failure.next }}</p>
        <p v-if="failureHint !== ''" class="caption preview-failure-text">{{ failureHint }}</p>
        <div class="inline preview-failure-actions">
          <Button v-if="failureKind === 'version-missing' && availableVersions.length > 0" label="切换到最新版本" size="small" @click="switchToLatest" />
          <Button v-if="failureKind === 'artifact-missing' && availableVersions.length > 0" label="切换到最新版本" size="small" @click="switchToLatest" />
          <Button v-if="failureKind === 'ticket-expired' || failureKind === 'load-timeout' || failureKind === 'unknown'" label="重试" size="small" @click="retry" />
          <Button v-if="failureKind === 'load-timeout'" label="在新窗口打开" size="small" outlined @click="openInNewWindow" />
          <Button label="返回蓝图列表" size="small" outlined @click="goBack" />
        </div>
      </div>

      <iframe
        v-if="frameSrc !== '' && failure === null"
        :src="frameSrc"
        class="preview-frame"
        :class="{ 'is-hidden': frameLoading }"
        sandbox="allow-scripts allow-popups"
        referrerpolicy="no-referrer"
        :title="`${blueprintName} ${currentVersion} 预览`"
        @load="onFrameLoad"
      />
    </div>
  </div>
</template>

<style scoped>
.preview-root {
  background: var(--bg);
  display: flex;
  flex-direction: column;
  inset: 0;
  position: fixed;
}

.preview-toolbar {
  align-items: center;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
}

.preview-title {
  font-size: var(--text-sm);
  font-weight: 600;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-body {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}

.preview-frame {
  border: 0;
  height: 100%;
  width: 100%;
}

.is-hidden {
  visibility: hidden;
}

.preview-overlay {
  align-items: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  justify-content: center;
  padding: var(--space-6);
  text-align: center;
  width: 100%;
}

.preview-failure {
  background: var(--bg);
}

.preview-failure-text {
  max-width: 36rem;
}

.preview-failure-actions {
  flex-wrap: wrap;
  justify-content: center;
}
</style>
