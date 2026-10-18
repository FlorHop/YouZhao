<script setup lang="ts">
/**
 * 区段二「管理员与可委派范围」的「添加用户管理员」对话框
 * （设计 `docs/frontend-design.md` §6 区段二 / §8 流程④）。
 * 只做任命；可委派范围随后在区段一为该管理员分配查看范围时确定。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Select from 'primevue/select';
import { ref, watch } from 'vue';

interface CandidateOption {
  label: string;
  value: string;
}

const visible = defineModel<boolean>('visible', { required: true });

defineProps<{
  candidates: CandidateOption[];
  submitting: boolean;
  errorText: string;
}>();

const emit = defineEmits<{ submit: [id: string] }>();

const selectedId = ref<string | null>(null);

watch(visible, (open) => {
  if (open) selectedId.value = null;
});

function onConfirm(): void {
  if (selectedId.value === null) return;
  emit('submit', selectedId.value);
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    header="添加用户管理员"
    :modal="true"
    :draggable="false"
    :style="{ width: '32rem' }"
  >
    <p class="caption">
      任命后他会成为用户管理员，可以管理你指派给他的普通用户。他的可委派范围等于他自己随后在
      「查看范围分配」中被授予的查看范围，请任命后到区段一为他分配。
    </p>
    <div class="field">
      <label for="new-admin-candidate">选择普通用户</label>
      <Select
        v-model="selectedId"
        input-id="new-admin-candidate"
        :options="candidates"
        option-label="label"
        option-value="value"
        placeholder="选择一个普通用户"
        filter
      />
    </div>
    <p v-if="candidates.length === 0" class="caption">当前没有可以任命的普通用户。</p>
    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <template #footer>
      <div class="inline">
        <Button
          label="取消"
          text
          severity="secondary"
          :disabled="submitting"
          @click="visible = false"
        />
        <Button
          label="任命管理员"
          icon="pi pi-check"
          :loading="submitting"
          :disabled="selectedId === null"
          @click="onConfirm"
        />
      </div>
    </template>
  </Dialog>
</template>
