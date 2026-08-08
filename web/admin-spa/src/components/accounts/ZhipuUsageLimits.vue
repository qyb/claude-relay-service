<template>
  <div
    class="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-2 dark:border-gray-600/60 dark:bg-gray-700/70"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="text-xs font-semibold text-gray-700 dark:text-gray-200"
            >GLM Coding Plan</span
          >
          <span
            v-if="data?.source === 'cache'"
            class="rounded bg-gray-200 px-1 py-0.5 text-[10px] text-gray-500 dark:bg-gray-600 dark:text-gray-300"
          >
            缓存
          </span>
          <span
            v-if="data?.stale"
            class="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
          >
            已过期
          </span>
        </div>
        <div v-if="data?.plan" class="truncate text-[11px] text-gray-500 dark:text-gray-400">
          {{ data.plan }}
        </div>
      </div>

      <button
        class="shrink-0 text-xs text-gray-400 transition-colors hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-indigo-300"
        :disabled="refreshing || loading"
        :title="refreshing ? '刷新中...' : '刷新 GLM 使用限额'"
        type="button"
        @click="$emit('refresh')"
      >
        <i class="fas fa-sync-alt" :class="{ 'fa-spin': refreshing }" />
      </button>
    </div>

    <div v-if="loading && !data" class="flex items-center gap-2 text-xs text-gray-400">
      <i class="fas fa-spinner fa-spin" />
      <span>加载限额...</span>
    </div>

    <div
      v-if="loadError"
      class="rounded bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:bg-red-900/20 dark:text-red-300"
    >
      {{ loadError }}
    </div>

    <div
      v-if="statusMessage"
      class="rounded px-2 py-1 text-[11px]"
      :class="
        data?.stale
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
          : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300'
      "
    >
      {{ statusMessage }}
    </div>

    <div v-if="normalizedWindows.length" class="space-y-2">
      <div v-for="window in normalizedWindows" :key="window.kind" class="space-y-1">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex min-w-[34px] justify-center rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="windowMeta(window.kind).badgeClass"
          >
            {{ windowMeta(window.kind).label }}
          </span>
          <div class="h-2 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600">
            <div
              class="h-2 rounded-full transition-all duration-300"
              :class="windowMeta(window.kind).barClass"
              :style="{ width: `${window.usedPercent}%` }"
            />
          </div>
          <span class="w-12 text-right text-xs font-semibold text-gray-800 dark:text-gray-100">
            {{ formatPercent(window.usedPercent) }}
          </span>
        </div>
        <div
          class="flex items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400"
        >
          <span>剩余 {{ formatPercent(window.remainingPercent) }}</span>
          <span :title="window.resetsAt || ''">
            重置剩余 {{ formatZhipuResetRemaining(window.resetsAt, nowMs) }}
          </span>
        </div>
      </div>
    </div>

    <div
      v-else-if="!loading && !loadError && !statusMessage"
      class="text-xs text-gray-400 dark:text-gray-500"
    >
      暂无限额数据
    </div>

    <div v-if="data?.updatedAt" class="text-[10px] text-gray-400 dark:text-gray-500">
      更新于 {{ formatUpdatedAt(data.updatedAt) }}
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  ZHIPU_WINDOW_META,
  formatZhipuResetRemaining,
  normalizeZhipuUsageWindows
} from '@/utils/zhipuUsageLimits'

const props = defineProps({
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  loadError: { type: String, default: '' },
  refreshing: { type: Boolean, default: false }
})

defineEmits(['refresh'])

const nowMs = ref(Date.now())
let updateTimer = null

const normalizedWindows = computed(() => normalizeZhipuUsageWindows(props.data?.windows))

const statusMessage = computed(() => {
  if (!props.data || props.data.status === 'ok') {
    return ''
  }
  return props.data.errorMessage || 'GLM 使用限额暂时不可用'
})

const windowMeta = (kind) => ZHIPU_WINDOW_META[kind] || ZHIPU_WINDOW_META.weekly

const formatPercent = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '--'
}

const formatUpdatedAt = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(() => {
  updateTimer = window.setInterval(() => {
    nowMs.value = Date.now()
  }, 60 * 1000)
})

onUnmounted(() => {
  if (updateTimer !== null) {
    window.clearInterval(updateTimer)
  }
})
</script>
