<template>
  <section class="page" data-module="govern">
    <header class="page-head">
      <div>
        <h2>存储治理管理</h2>
        <p class="page-desc">维护存储治理策略的输入、执行约束与结果记录，为存储生命周期管理提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记治理策略</button>
        <button class="btn" type="button" @click="exportRows">导出存储治理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无存储治理数据，可先登记治理策略</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条存储治理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="seal-banner">
      <header class="seal-banner-head">
        <h3>封存名单（沿 partition→govern 引用边，仅当前 revoke_seq）</h3>
        <RouterLink class="link" to="/seal">前往封存版本治理 →</RouterLink>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>治理策略</th>
            <th>引用分区</th>
            <th>治理参数</th>
            <th>封存状态</th>
            <th>快照版本</th>
            <th>分区当前版本</th>
            <th>回执</th>
            <th>只读</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="candidate in activeCandidates" :key="candidate.govCode">
            <td>{{ candidate.govCode }}</td>
            <td>{{ candidate.partCode }}</td>
            <td>{{ candidate.governType }}={{ candidate.retainDays }}</td>
            <td><span :class="sealStateTag(candidate.state)">{{ sealStateLabel(candidate.state) }}</span></td>
            <td :class="candidate.snapshotRevokeSeq !== currentSeq(candidate.partCode) ? 'cell-stale' : ''">
              seq={{ candidate.snapshotRevokeSeq }} / {{ candidate.snapshotSealRev ?? 'null' }}
            </td>
            <td>seq={{ currentSeq(candidate.partCode) }}</td>
            <td>{{ candidate.receiptNo ?? '—' }}</td>
            <td>{{ candidate.readonly ? '是' : '否' }}</td>
          </tr>
          <tr v-if="!activeCandidates.length">
            <td colspan="8" class="empty-state">当前版本区暂无封存候选</td>
          </tr>
        </tbody>
      </table>

      <h4 class="archive-title">archive=readonly 只读归档区</h4>
      <table class="data-table archive-table">
        <thead>
          <tr><th>治理策略</th><th>引用分区</th><th>回执</th><th>归档版本</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="candidate in sealBoard.archive" :key="candidate.govCode">
            <td>{{ candidate.govCode }}</td>
            <td>{{ candidate.partCode }}</td>
            <td>{{ candidate.receiptNo ?? '—' }}</td>
            <td>seq={{ candidate.snapshotRevokeSeq }} / {{ candidate.snapshotSealRev ?? 'null' }}</td>
            <td>{{ candidate.lastNote }}</td>
          </tr>
          <tr v-if="!sealBoard.archive.length">
            <td colspan="5" class="empty-state">归档区为空</td>
          </tr>
        </tbody>
      </table>
      <p v-if="sealDrift.length" class="error-text seal-drift">
        版本漂移：<span v-for="d in sealDrift" :key="d.govCode">{{ d.detail }}；</span>
      </p>
      <p v-else class="ok-text seal-drift">核对一致：本清单与分区详情、概览同源，未持旧快照产出封存名单。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { loadSealBoard } from '@/api/seal-service'
import type { EntryRow } from '@/data/types'
import type { SealBoard, SealCandidateState } from '@/data/seal-types'

const meta = moduleMeta('govern')
const columns = ["策略编号", "目标表名", "治理类型", "冷热判定字段", "生命周期天数", "归档目标", "回收站保留", "执行频率"]
const actions = ["提交校验", "启用治理", "停用治理"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "治理策略总数", "value": 0}, {"label": "已启用策略", "value": 0}, {"label": "待校验策略", "value": 0}]

const sealBoard = ref<SealBoard>(loadSealBoard())
const sealDrift = computed(() => sealBoard.value.drift)
const activeCandidates = computed(() =>
  sealBoard.value.state.candidates.filter((candidate) => candidate.state !== 'readonly'),
)

function currentSeq(partCode: string): number {
  return sealBoard.value.activePartitions.find((part) => part.partCode === partCode)?.revokeSeq ?? 0
}

function sealStateLabel(state: SealCandidateState | string): string {
  const map: Record<string, string> = {
    pending: '待封存',
    sealed: '已封存',
    revoked: '已吊销',
    readonly: '只读归档',
  }
  return map[state] ?? state
}

function sealStateTag(state: SealCandidateState | string): string {
  const map: Record<string, string> = {
    pending: 'tag tag-pending',
    sealed: 'tag tag-ok',
    revoked: 'tag tag-bad',
    readonly: 'tag tag-readonly',
  }
  return map[state] ?? 'tag'
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '治理策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '存储治理列表读取失败'
  }
}

onMounted(reload)
</script>
