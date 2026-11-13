<template>
  <section class="page" data-module="partition">
    <header class="page-head">
      <div>
        <h2>分区策略管理</h2>
        <p class="page-desc">维护分区治理方案的输入、执行约束与结果记录，为分区策略提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记分区方案</button>
        <button class="btn" type="button" @click="exportRows">导出分区策略清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无分区策略数据，可先登记分区方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条分区策略记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="seal-banner">
      <header class="seal-banner-head">
        <h3>封存版本（seal_rev / revoke_seq）— 以分区策略为主对象，详情与侧栏同源</h3>
        <RouterLink class="link" to="/seal">前往封存版本治理 →</RouterLink>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>分区方案</th>
            <th>分区窗口</th>
            <th>当前 seal_rev</th>
            <th>当前 revoke_seq</th>
            <th>关联治理候选</th>
            <th>异常牌</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="part in sealBoard.activePartitions" :key="part.partCode">
            <td>{{ part.partCode }}（{{ part.partName }}）</td>
            <td>{{ part.windowStart }} ~ {{ part.windowEnd }}</td>
            <td>
              <span :class="part.sealRev === null ? 'tag tag-null' : 'tag tag-ok'">
                {{ part.sealRev ?? 'null（已吊销）' }}
              </span>
            </td>
            <td><strong>{{ part.revokeSeq }}</strong></td>
            <td>
              <span v-for="candidate in candidatesOf(part.partCode)" :key="candidate.govCode" class="cand-chip">
                {{ candidate.govCode }} · {{ sealStateLabel(candidate.state) }} · seq={{ candidate.snapshotRevokeSeq }}
              </span>
            </td>
            <td>
              <span :class="part.abnormal ? 'tag tag-bad' : 'tag tag-ok'">
                {{ part.abnormal ? '未回收' : '已回收' }}
              </span>
            </td>
          </tr>
          <tr v-if="!sealBoard.activePartitions.length">
            <td colspan="6" class="empty-state">暂无封存版本数据</td>
          </tr>
        </tbody>
      </table>
      <p v-if="sealDrift.length" class="error-text seal-drift">
        版本漂移：<span v-for="d in sealDrift" :key="d.govCode">{{ d.detail }}；</span>
      </p>
      <p v-else class="ok-text seal-drift">核对一致：本页详情与封存治理清单、概览使用同一 revoke_seq 数据源，无残留旧章。</p>
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
import type { GovernCandidate, SealCandidateState } from '@/data/seal-types'

const meta = moduleMeta('partition')
const columns = ["方案编号", "目标表名", "分区字段", "分区粒度", "保留天数", "冷热阈值", "预建天数", "归档路径"]
const actions = ["提交校验", "启用方案", "停用方案"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "分区方案总数", "value": 0}, {"label": "已启用方案", "value": 0}, {"label": "待校验方案", "value": 0}]

const sealBoard = ref(loadSealBoard())
const sealDrift = computed(() => sealBoard.value.drift)

function candidatesOf(partCode: string): GovernCandidate[] {
  return sealBoard.value.state.candidates.filter((candidate) => candidate.partCode === partCode)
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
  errorMessage.value = '分区方案登记入口尚未接入审批流'
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
    errorMessage.value = error instanceof Error ? error.message : '分区策略列表读取失败'
  }
}

onMounted(reload)
</script>
