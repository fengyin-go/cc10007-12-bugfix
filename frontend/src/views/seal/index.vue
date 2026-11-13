<template>
  <section class="page" data-module="seal">
    <header class="page-head">
      <div>
        <h2>封存版本治理</h2>
        <p class="page-desc">
          沿 partition→govern 引用边下发 seal_rev / revoke_seq：pending 立即吊销，已封存 receipt 只读；
          seal/unseal 交叉以 revoke_seq 定唯一版本，旧快照不得复活任何 pending 计划。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="toggleFault">
          {{ board.state.faultArmed ? '解除故障注入' : '注入一次写入故障' }}
        </button>
        <button class="btn ghost" type="button" @click="onReset">重置断点现场</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card" :class="{ 'stat-alert': item.alert }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="board.state.pendingTx" class="notice-bar notice-warn">
      检测到中断事务：{{ board.state.pendingTx.op }}（{{ board.state.pendingTx.partCode }}），
      停在步骤「{{ board.state.pendingTx.step }}」。刷新页面即按证据回滚恢复。
    </div>
    <div v-if="board.drift.length" class="notice-bar notice-warn">
      发现 {{ board.drift.length }} 处版本漂移（残留旧章）：
      <span v-for="d in board.drift" :key="d.govCode" class="drift-chip">{{ d.detail }}</span>
    </div>
    <div v-else class="notice-bar notice-ok">一致性核对通过：侧栏列表、PART 详情、概览同源，无残留旧章。</div>

    <p v-if="message" class="page-foot message-line" :class="messageOk ? 'ok-text' : 'error-text'">
      <span>{{ message }}</span>
      <button v-if="lastFailedPart" class="btn primary retry-btn" type="button" @click="retry">重试下发</button>
    </p>

    <h3 class="section-title">分区方案（主对象，只显示当前 revoke_seq）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>分区方案</th>
          <th>目标表</th>
          <th>分区窗口</th>
          <th>分区字段</th>
          <th>当前 seal_rev</th>
          <th>当前 revoke_seq</th>
          <th>异常牌</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="part in board.activePartitions" :key="part.partCode">
          <td>{{ part.partCode }}</td>
          <td>{{ part.partName }}</td>
          <td>{{ part.windowStart }} ~ {{ part.windowEnd }}</td>
          <td>{{ part.partitionField }}</td>
          <td>
            <span :class="part.sealRev === null ? 'tag tag-null' : 'tag tag-ok'">
              {{ part.sealRev ?? 'null（已吊销）' }}
            </span>
          </td>
          <td><strong>{{ part.revokeSeq }}</strong></td>
          <td>
            <span :class="part.abnormal ? 'tag tag-bad' : 'tag tag-ok'">
              {{ part.abnormal ? '未回收' : '已回收' }}
            </span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="onPropagate(part.partCode)">下发吊销</button>
            <button class="link" type="button" @click="onReview(part.partCode)">回看分区窗口</button>
            <button
              class="link"
              type="button"
              :disabled="part.sealRev === null"
              @click="onUnseal(part.partCode, part.revokeSeq)"
            >
              启封( unseal )
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">治理候选清单（当前版本）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>治理策略</th>
          <th>引用分区</th>
          <th>治理参数</th>
          <th>状态</th>
          <th>快照版本</th>
          <th>分区当前版本</th>
          <th>回执</th>
          <th>只读</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="candidate in activeCandidates" :key="candidate.govCode">
          <td>{{ candidate.govCode }}</td>
          <td>{{ candidate.partCode }}</td>
          <td>{{ candidate.governType }}={{ candidate.retainDays }}</td>
          <td><span :class="stateTag(candidate.state)">{{ stateLabel(candidate.state) }}</span></td>
          <td :class="candidate.snapshotRevokeSeq !== currentSeq(candidate.partCode) ? 'cell-stale' : ''">
            seq={{ candidate.snapshotRevokeSeq }} / {{ candidate.snapshotSealRev ?? 'null' }}
          </td>
          <td>seq={{ currentSeq(candidate.partCode) }}</td>
          <td>{{ candidate.receiptNo ?? '—' }}</td>
          <td>{{ candidate.readonly ? '是' : '否' }}</td>
          <td class="row-actions">
            <button
              class="link"
              type="button"
              :disabled="candidate.state !== 'pending'"
              @click="onSeal(candidate)"
            >
              封存
            </button>
          </td>
        </tr>
        <tr v-if="!activeCandidates.length">
          <td colspan="9" class="empty-state">当前版本区暂无候选（pending/sealed/revoked 均为空）</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">
      archive=readonly 只读归档区
      <span class="title-hint">已封存 receipt 只读保留，不参与再封存/复活</span>
    </h3>
    <table class="data-table archive-table">
      <thead>
        <tr>
          <th>治理策略</th>
          <th>引用分区</th>
          <th>状态</th>
          <th>封存回执</th>
          <th>归档时版本</th>
          <th>只读</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="candidate in board.archive" :key="candidate.govCode">
          <td>{{ candidate.govCode }}</td>
          <td>{{ candidate.partCode }}</td>
          <td><span class="tag tag-readonly">readonly</span></td>
          <td>{{ candidate.receiptNo ?? '—' }}</td>
          <td>seq={{ candidate.snapshotRevokeSeq }} / {{ candidate.snapshotSealRev ?? 'null' }}</td>
          <td>是</td>
          <td>{{ candidate.lastNote }}</td>
        </tr>
        <tr v-if="!board.archive.length">
          <td colspan="7" class="empty-state">归档区为空：还没有 receipt 随版本吊销迁入只读区</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">回看核对（以分区策略为主对象）</h3>
    <div v-if="review" class="review-box">
      <p :class="review.ok ? 'ok-text' : 'error-text'">{{ review.message }}</p>
      <table v-if="review.rows.length" class="data-table">
        <thead>
          <tr><th>治理策略</th><th>状态</th><th>快照 seq</th><th>当前 seq</th><th>是否对齐</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in review.rows" :key="row.govCode">
            <td>{{ row.govCode }}</td>
            <td>{{ stateLabel(row.state) }}</td>
            <td>{{ row.snapshotSeq }}</td>
            <td>{{ row.currentSeq }}</td>
            <td>
              <span :class="row.aligned ? 'tag tag-ok' : 'tag tag-bad'">{{ row.aligned ? '对齐' : '漂移' }}</span>
            </td>
            <td>{{ row.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="page-foot">点击分区行的「回看分区窗口」，核对分区窗口与候选版本。</p>

    <h3 class="section-title">证据流水（下发 / 封存 / 失败 / 中断恢复均留痕）</h3>
    <table class="data-table journal-table">
      <thead>
        <tr><th>时间</th><th>类型</th><th>分区</th><th>治理</th><th>seq</th><th>结果</th><th>说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="event in reversedEvents" :key="event.id">
          <td>{{ formatTime(event.at) }}</td>
          <td><span class="kind-chip">{{ kindLabel(event.kind) }}</span></td>
          <td>{{ event.partCode ?? '—' }}</td>
          <td>{{ event.govCode ?? '—' }}</td>
          <td>{{ event.revokeSeq }}</td>
          <td :class="event.ok ? 'ok-text' : 'error-text'">{{ event.ok ? '成功' : '失败' }}</td>
          <td>{{ event.message }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  armFault,
  clearFault,
  consistencyCheck,
  loadSealBoard,
  propagateRevocation,
  resetSealCenter,
  retryPropagation,
  reviewPartition,
  sealCandidate,
  unsealPartition,
} from '@/api/seal-service'
import type { GovernCandidate, SealBoard, SealCandidateState } from '@/data/seal-types'

const board = ref<SealBoard>(loadSealBoard())
const message = ref('')
const messageOk = ref(true)
const lastFailedPart = ref<string | null>(null)
const review = ref<ReturnType<typeof reviewPartition> | null>(null)

const activeCandidates = computed(() =>
  board.value.state.candidates.filter((candidate) => candidate.state !== 'readonly'),
)
const reversedEvents = computed(() => [...board.value.state.events].reverse())

const statCards = computed(() => [
  { label: '分区方案', value: board.value.stats.partitionTotal, alert: false },
  { label: '已吊销分区(seal_rev=null)', value: board.value.stats.revokedPartitionTotal, alert: false },
  { label: '待处理 pending', value: board.value.stats.pendingTotal, alert: board.value.stats.pendingTotal > 0 },
  { label: '已封存 receipt', value: board.value.stats.sealedTotal, alert: false },
  { label: '已吊销候选', value: board.value.stats.revokedCandidateTotal, alert: false },
  { label: '只读归档', value: board.value.stats.archiveTotal, alert: false },
  { label: '未回收异常牌', value: board.value.stats.abnormalTotal, alert: board.value.stats.abnormalTotal > 0 },
  { label: 'revoke_seq 水位', value: board.value.stats.watermark, alert: false },
])

function refresh(): void {
  board.value = loadSealBoard()
}

function notify(ok: boolean, text: string, retryable = false, partCode: string | null = null): void {
  messageOk.value = ok
  message.value = retryable ? `${text}（可重试）` : text
  lastFailedPart.value = retryable ? partCode : null
}

function currentSeq(partCode: string): number {
  return board.value.activePartitions.find((part) => part.partCode === partCode)?.revokeSeq ?? 0
}

function onPropagate(partCode: string): void {
  const result = propagateRevocation(partCode)
  refresh()
  notify(result.ok, result.message, result.retryable, partCode)
}

function onSeal(candidate: GovernCandidate): void {
  const result = sealCandidate(candidate.govCode, currentSeq(candidate.partCode))
  refresh()
  notify(result.ok, result.message)
}

function onUnseal(partCode: string, expectedSeq: number): void {
  const result = unsealPartition(partCode, expectedSeq)
  refresh()
  notify(result.ok, result.message, result.retryable, partCode)
}

function onReview(partCode: string): void {
  review.value = reviewPartition(partCode)
  refresh()
  notify(review.value.ok, review.value.message)
}

function toggleFault(): void {
  const result = board.value.state.faultArmed ? clearFault() : armFault()
  refresh()
  notify(true, result.message)
}

function onReset(): void {
  const result = resetSealCenter()
  review.value = null
  refresh()
  notify(true, result.message)
}

function retry(): void {
  if (lastFailedPart.value) {
    const result = retryPropagation(lastFailedPart.value)
    refresh()
    notify(result.ok, result.message, result.retryable, lastFailedPart.value)
  }
}

function stateLabel(state: SealCandidateState | string): string {
  const map: Record<string, string> = {
    pending: '待封存',
    sealed: '已封存',
    revoked: '已吊销',
    readonly: '只读归档',
  }
  return map[state] ?? state
}

function stateTag(state: SealCandidateState | string): string {
  const map: Record<string, string> = {
    pending: 'tag tag-pending',
    sealed: 'tag tag-ok',
    revoked: 'tag tag-bad',
    readonly: 'tag tag-readonly',
  }
  return map[state] ?? 'tag'
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    propagate: '下发',
    seal: '封存',
    unseal: '启封',
    revoke: '吊销',
    archive: '归档',
    reclaim: '异常回收',
    'no-hit': '未命中',
    failure: '失败',
    retry: '重试',
    recover: '中断恢复',
    check: '核对',
    reset: '重置',
  }
  return map[kind] ?? kind
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

// 进入页面先跑一次一致性核对，留下核对证据。
consistencyCheck()
refresh()
</script>
