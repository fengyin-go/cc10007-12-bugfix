<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <header class="page-head seal-overview-head">
      <div>
        <h3>封存版本治理（当前 revoke_seq，异常牌按回收后统计）</h3>
        <p class="page-desc">数据与分区详情、治理清单同源；只读 receipt 在独立 archive=readonly 区。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/seal">进入封存版本治理</RouterLink>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in sealCards" :key="card.label" class="stat-card" :class="{ 'stat-alert': card.alert }">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <p v-if="sealDrift.length" class="error-text">
      残留旧章：<span v-for="d in sealDrift" :key="d.govCode">{{ d.detail }}；</span>
    </p>
    <p v-else class="ok-text">概览核对一致：仅显示当前 revoke_seq，无残留旧章。</p>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { loadSealBoard } from '@/api/seal-service'
import type { OverviewResult } from '@/data/types'
import type { SealBoard } from '@/data/seal-types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const sealBoard = ref<SealBoard>(loadSealBoard())

const sealCards = computed(() => [
  { label: 'revoke_seq 水位', value: sealBoard.value.stats.watermark, alert: false },
  { label: '已吊销分区(seal_rev=null)', value: sealBoard.value.stats.revokedPartitionTotal, alert: false },
  { label: '待处理 pending', value: sealBoard.value.stats.pendingTotal, alert: sealBoard.value.stats.pendingTotal > 0 },
  { label: '已封存 receipt', value: sealBoard.value.stats.sealedTotal, alert: false },
  { label: '已吊销候选', value: sealBoard.value.stats.revokedCandidateTotal, alert: false },
  { label: 'archive 只读归档', value: sealBoard.value.stats.archiveTotal, alert: false },
  { label: '未回收异常牌', value: sealBoard.value.stats.abnormalTotal, alert: sealBoard.value.stats.abnormalTotal > 0 },
])
const sealDrift = computed(() => sealBoard.value.drift)

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  sealBoard.value = loadSealBoard()
}

onMounted(refresh)
</script>
