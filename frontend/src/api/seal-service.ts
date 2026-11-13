import {
  nextEventId,
  persistSeal,
  resetSealStorage,
  sealState,
} from '@/data/seal-store'
import type {
  GovernCandidate,
  PartitionSeal,
  SealBoard,
  SealEvent,
  SealOpResult,
  SealState,
} from '@/data/seal-types'

/**
 * 封存版本治理服务。所有跨模块判定都集中在这里，页面只读渲染、不做业务判断，
 * 从而保证侧栏列表、PART 详情、overview 同源，不可能再出现「列表一个章、详情另一个结果」。
 */

function nowIso(): string {
  return new Date().toISOString()
}

function pushEvent(
  state: SealState,
  event: Omit<SealEvent, 'id' | 'at'>,
): void {
  state.events.push({ id: nextEventId(state.events), at: nowIso(), ...event })
}

function findPartition(state: SealState, partCode: string): PartitionSeal | undefined {
  return state.partitions.find((part) => part.partCode === partCode)
}

function findCandidate(state: SealState, govCode: string): GovernCandidate | undefined {
  return state.candidates.find((candidate) => candidate.govCode === govCode)
}

/** 沿引用边找出某分区当前所有治理候选。 */
function candidatesOf(state: SealState, partCode: string): GovernCandidate[] {
  return state.candidates.filter((candidate) => candidate.partCode === partCode)
}

/** 故障注入：武装后下一次写操作失败，用于演示「失败可重试 + 留异常原因」。 */
export function armFault(): SealOpResult {
  const state = sealState()
  state.faultArmed = true
  persistSeal(state)
  return { ok: true, message: '已注入一次写入故障，下一次动作将失败并可重试', hits: [], retryable: false }
}

export function clearFault(): SealOpResult {
  const state = sealState()
  state.faultArmed = false
  persistSeal(state)
  return { ok: true, message: '故障注入已解除', hits: [], retryable: false }
}

/** 统一的写入前置：故障注入触发可重试失败，并留下异常原因证据。 */
function guardWrite(state: SealState, op: string, partCode: string, seq: number): SealOpResult | null {
  if (state.faultArmed) {
    state.faultArmed = false
    pushEvent(state, {
      kind: 'failure',
      partCode,
      govCode: null,
      sealRev: findPartition(state, partCode)?.sealRev ?? null,
      revokeSeq: seq,
      ok: false,
      message: `${op} 写入失败（注入故障）：状态未改动，可点击重试`,
    })
    persistSeal(state)
    return { ok: false, message: `${op} 失败：模拟写入异常，数据保持原样，可重试`, hits: [], retryable: true }
  }
  return null
}

/**
 * 核心动作：把分区的 seal_rev / revoke_seq 沿 partition→govern 引用边下发。
 * - pending 候选：快照序号落后于分区当前序号 → 立即 revoke；
 * - sealed 回执：只读，不覆盖状态，迁入 archive=readonly 区；
 * - 已经与当前序号一致的候选不重复处理（幂等）。
 */
export function propagateRevocation(partCode: string): SealOpResult {
  const state = sealState()
  const part = findPartition(state, partCode)
  if (!part) {
    return { ok: false, message: `没有命中分区方案 ${partCode}，无引用边可下发`, hits: [], retryable: false }
  }

  const failed = guardWrite(state, '吊销下发', partCode, part.revokeSeq)
  if (failed) return failed

  const targets = candidatesOf(state, partCode)
  if (targets.length === 0) {
    pushEvent(state, {
      kind: 'no-hit',
      partCode,
      govCode: null,
      sealRev: part.sealRev,
      revokeSeq: part.revokeSeq,
      ok: true,
      message: `${partCode} 没有关联任何治理候选，沿引用边下发未命中对象`,
    })
    persistSeal(state)
    return { ok: false, message: `未命中：${partCode} 下没有治理候选，无需下发`, hits: [], retryable: false }
  }

  // 记录中断事务：若写入过程被打断，下次加载可据此回滚恢复。
  state.pendingTx = {
    op: 'propagate',
    partCode,
    govCode: null,
    expectedSeq: part.revokeSeq,
    startedAt: nowIso(),
    step: 'begin',
  }
  persistSeal(state)

  const hits: string[] = []
  for (const candidate of targets) {
    const stale = candidate.snapshotRevokeSeq < part.revokeSeq
    if (candidate.state === 'pending') {
      if (stale) {
        // pending 计划绝不允许借旧快照复活：落后版本立即吊销。
        candidate.state = 'revoked'
        candidate.readonly = false
        candidate.abnormal = false
        candidate.snapshotRevokeSeq = part.revokeSeq
        candidate.snapshotSealRev = part.sealRev
        candidate.lastNote = `pending 计划随分区 seq=${part.revokeSeq} 立即吊销，旧快照（retain=${candidate.retainDays}）失效`
        hits.push(candidate.govCode)
        pushEvent(state, {
          kind: 'revoke',
          partCode,
          govCode: candidate.govCode,
          sealRev: part.sealRev,
          revokeSeq: part.revokeSeq,
          ok: true,
          message: `${candidate.govCode} pending 候选立即吊销，旧 retain=${candidate.retainDays} 快照作废`,
        })
      } else {
        pushEvent(state, {
          kind: 'check',
          partCode,
          govCode: candidate.govCode,
          sealRev: part.sealRev,
          revokeSeq: part.revokeSeq,
          ok: true,
          message: `${candidate.govCode} 已在当前 seq=${part.revokeSeq}，跳过（幂等）`,
        })
      }
    } else if (candidate.state === 'sealed') {
      // 已封存 receipt 只读：不改写封存事实，只迁入 archive=readonly。
      candidate.state = 'readonly'
      candidate.readonly = true
      candidate.snapshotRevokeSeq = part.revokeSeq
      candidate.snapshotSealRev = part.sealRev
      candidate.lastNote = `封存回执只读保留，随 seq=${part.revokeSeq} 迁入 archive=readonly`
      hits.push(candidate.govCode)
      pushEvent(state, {
        kind: 'archive',
        partCode,
        govCode: candidate.govCode,
        sealRev: part.sealRev,
        revokeSeq: part.revokeSeq,
        ok: true,
        message: `${candidate.govCode} 已封存 receipt（${candidate.receiptNo ?? '-'}）只读，迁入归档区`,
      })
    } else {
      // revoked / readonly 终态幂等核对。
      candidate.snapshotRevokeSeq = part.revokeSeq
      candidate.snapshotSealRev = part.sealRev
      pushEvent(state, {
        kind: 'check',
        partCode,
        govCode: candidate.govCode,
        sealRev: part.sealRev,
        revokeSeq: part.revokeSeq,
        ok: true,
        message: `${candidate.govCode} 已是终态「${candidate.state}」，仅对齐版本号`,
      })
    }
  }

  // 分区异常牌回收：下发完成且没有遗留异常候选。
  const stillAbnormal = targets.some((candidate) => candidate.abnormal)
  if (part.abnormal && !stillAbnormal) {
    part.abnormal = false
    part.lastNote = `吊销已沿引用边下发至 seq=${part.revokeSeq}，异常牌回收`
    pushEvent(state, {
      kind: 'reclaim',
      partCode,
      govCode: null,
      sealRev: part.sealRev,
      revokeSeq: part.revokeSeq,
      ok: true,
      message: `${partCode} 概览异常牌已回收`,
    })
  }

  state.pendingTx = null
  pushEvent(state, {
    kind: 'propagate',
    partCode,
    govCode: null,
    sealRev: part.sealRev,
    revokeSeq: part.revokeSeq,
    ok: true,
    message: `下发完成：${hits.length ? hits.join('、') : '无待处理候选'}，当前 revoke_seq=${part.revokeSeq}`,
  })
  persistSeal(state)

  if (hits.length === 0) {
    return { ok: true, message: `${partCode} 所有候选都已在当前版本，无新增下发`, hits: [], retryable: false }
  }
  return {
    ok: true,
    message: `已按 revoke_seq=${part.revokeSeq} 下发：${hits.join('、')}（pending 立即吊销，receipt 只读归档）`,
    hits,
    retryable: false,
  }
}

/**
 * 封存某个 pending 候选。seal/unseal 交叉时以分区 revoke_seq 定唯一版本：
 * 调用方必须带 expectedSeq，落后于分区当前序号（旧快照）一律拒绝，pending 不得复活。
 */
export function sealCandidate(govCode: string, expectedSeq: number): SealOpResult {
  const state = sealState()
  const candidate = findCandidate(state, govCode)
  if (!candidate) {
    return { ok: false, message: `没有命中治理候选 ${govCode}`, hits: [], retryable: false }
  }
  const part = findPartition(state, candidate.partCode)
  if (!part) {
    return { ok: false, message: `${govCode} 引用的分区 ${candidate.partCode} 不存在，禁止封存`, hits: [], retryable: false }
  }

  const failed = guardWrite(state, '封存', part.partCode, part.revokeSeq)
  if (failed) return failed

  if (expectedSeq !== part.revokeSeq) {
    pushEvent(state, {
      kind: 'failure',
      partCode: part.partCode,
      govCode,
      sealRev: part.sealRev,
      revokeSeq: part.revokeSeq,
      ok: false,
      message: `封存被拒：请求基于旧 seq=${expectedSeq}，分区当前 seq=${part.revokeSeq}，旧快照不得复活 pending 计划`,
    })
    persistSeal(state)
    return {
      ok: false,
      message: `版本冲突：当前 revoke_seq=${part.revokeSeq}，你的快照停在 ${expectedSeq}，请先同步再封存`,
      hits: [],
      retryable: false,
    }
  }

  if (candidate.readonly || candidate.state === 'sealed' || candidate.state === 'readonly') {
    return { ok: false, message: `${govCode} 是只读封存回执，不能重复封存`, hits: [], retryable: false }
  }
  if (candidate.state === 'revoked') {
    return { ok: false, message: `${govCode} 已随旧版本吊销，禁止借旧快照复活`, hits: [], retryable: false }
  }

  state.pendingTx = {
    op: 'seal',
    partCode: part.partCode,
    govCode,
    expectedSeq: part.revokeSeq,
    startedAt: nowIso(),
    step: 'seal',
  }
  persistSeal(state)

  const receiptNo = `RCPT-${new Date().getFullYear()}-${String(candidate.id).padStart(4, '0')}`
  candidate.state = 'sealed'
  candidate.readonly = true
  candidate.receiptNo = receiptNo
  candidate.snapshotRevokeSeq = part.revokeSeq
  candidate.snapshotSealRev = part.sealRev
  candidate.abnormal = false
  candidate.lastNote = `按当前 seq=${part.revokeSeq} 封存，回执 ${receiptNo}，进入只读`

  state.pendingTx = null
  pushEvent(state, {
    kind: 'seal',
    partCode: part.partCode,
    govCode,
    sealRev: part.sealRev,
    revokeSeq: part.revokeSeq,
    ok: true,
    message: `${govCode} 封存成功，回执 ${receiptNo}（只读）`,
  })
  persistSeal(state)
  return { ok: true, message: `${govCode} 已封存，回执 ${receiptNo}`, hits: [govCode], retryable: false }
}

/**
 * 启封（unseal）：把分区封存版本吊销，seal_rev 置 null 并推进 revoke_seq。
 * 同样以 expectedSeq 做乐观版本控制，防止交叉操作覆盖更新的版本。
 */
export function unsealPartition(partCode: string, expectedSeq: number): SealOpResult {
  const state = sealState()
  const part = findPartition(state, partCode)
  if (!part) {
    return { ok: false, message: `没有命中分区方案 ${partCode}`, hits: [], retryable: false }
  }

  const failed = guardWrite(state, '启封', partCode, part.revokeSeq)
  if (failed) return failed

  if (expectedSeq !== part.revokeSeq) {
    pushEvent(state, {
      kind: 'failure',
      partCode,
      govCode: null,
      sealRev: part.sealRev,
      revokeSeq: part.revokeSeq,
      ok: false,
      message: `启封被拒：请求基于旧 seq=${expectedSeq}，当前 seq=${part.revokeSeq}`,
    })
    persistSeal(state)
    return { ok: false, message: `版本冲突：当前 revoke_seq=${part.revokeSeq}，请刷新后再启封`, hits: [], retryable: false }
  }

  state.pendingTx = {
    op: 'unseal',
    partCode,
    govCode: null,
    expectedSeq: part.revokeSeq,
    startedAt: nowIso(),
    step: 'unseal',
  }
  persistSeal(state)

  state.seqWatermark += 1
  part.revokeSeq = state.seqWatermark
  part.sealRev = null
  part.abnormal = true
  part.lastNote = `启封吊销封存版本，revoke_seq 推进到 ${part.revokeSeq}，等待下发`

  state.pendingTx = null
  pushEvent(state, {
    kind: 'unseal',
    partCode,
    govCode: null,
    sealRev: null,
    revokeSeq: part.revokeSeq,
    ok: true,
    message: `${partCode} seal_rev 置 null，revoke_seq=${part.revokeSeq}，下游待下发`,
  })
  persistSeal(state)

  // 启封后立即沿引用边下发，保持「吊销即生效」。
  const propagation = propagateRevocation(partCode)
  return {
    ok: propagation.ok,
    message: `启封成功（seq=${part.revokeSeq}）。${propagation.message}`,
    hits: propagation.hits,
    retryable: propagation.retryable,
  }
}

/** 重试上一次因故障失败的动作：重新触发下发（无副作用，幂等）。 */
export function retryPropagation(partCode: string): SealOpResult {
  const state = sealState()
  const part = findPartition(state, partCode)
  pushEvent(state, {
    kind: 'retry',
    partCode,
    govCode: null,
    sealRev: part?.sealRev ?? null,
    revokeSeq: part?.revokeSeq ?? 0,
    ok: true,
    message: `手动重试 ${partCode} 的吊销下发`,
  })
  persistSeal(state)
  return propagateRevocation(partCode)
}

/** 回看：以分区策略为主对象核对分区窗口，并比对候选快照是否落在当前版本。 */
export function reviewPartition(partCode: string): {
  ok: boolean
  message: string
  rows: { govCode: string; state: string; snapshotSeq: number; currentSeq: number; aligned: boolean; note: string }[]
} {
  const state = sealState()
  const part = findPartition(state, partCode)
  if (!part) {
    return { ok: false, message: `未命中分区方案 ${partCode}，无法回看分区窗口`, rows: [] }
  }
  const targets = candidatesOf(state, partCode)
  if (targets.length === 0) {
    pushEvent(state, {
      kind: 'no-hit',
      partCode,
      govCode: null,
      sealRev: part.sealRev,
      revokeSeq: part.revokeSeq,
      ok: true,
      message: `回看 ${partCode} 分区窗口（${part.windowStart}~${part.windowEnd}）未关联候选`,
    })
    persistSeal(state)
    return { ok: false, message: `未命中：${partCode} 没有治理候选`, rows: [] }
  }
  const rows = targets.map((candidate) => ({
    govCode: candidate.govCode,
    state: candidate.state,
    snapshotSeq: candidate.snapshotRevokeSeq,
    currentSeq: part.revokeSeq,
    aligned: candidate.snapshotRevokeSeq === part.revokeSeq,
    note: candidate.lastNote,
  }))
  pushEvent(state, {
    kind: 'check',
    partCode,
    govCode: null,
    sealRev: part.sealRev,
    revokeSeq: part.revokeSeq,
    ok: true,
    message: `回看分区窗口 ${part.windowStart}~${part.windowEnd}，核对 ${rows.length} 个候选版本`,
  })
  persistSeal(state)
  return {
    ok: true,
    message: `分区 ${partCode} 窗口 ${part.windowStart}~${part.windowEnd}，当前 revoke_seq=${part.revokeSeq}`,
    rows,
  }
}

/** 一致性核对：检测是否还有候选快照与分区当前 revoke_seq 漂移（列表/详情同源的证据）。 */
export function consistencyCheck(): SealBoard['drift'] {
  const state = sealState()
  const drift: SealBoard['drift'] = []
  for (const candidate of state.candidates) {
    const part = findPartition(state, candidate.partCode)
    if (!part) continue
    if (candidate.snapshotRevokeSeq !== part.revokeSeq) {
      drift.push({
        partCode: part.partCode,
        govCode: candidate.govCode,
        detail: `${candidate.govCode} 快照 seq=${candidate.snapshotRevokeSeq} ≠ 分区当前 seq=${part.revokeSeq}`,
      })
    }
  }
  if (drift.length === 0) {
    pushEvent(state, {
      kind: 'check',
      partCode: null,
      govCode: null,
      sealRev: null,
      revokeSeq: state.seqWatermark,
      ok: true,
      message: '一致性核对通过：侧栏列表、PART 详情、概览全部同源，无残留旧章',
    })
  } else {
    pushEvent(state, {
      kind: 'check',
      partCode: null,
      govCode: null,
      sealRev: null,
      revokeSeq: state.seqWatermark,
      ok: false,
      message: `发现 ${drift.length} 处版本漂移，需下发吊销`,
    })
  }
  persistSeal(state)
  return drift
}

/** 看板聚合：单一数据源，所有页面共用。 */
export function loadSealBoard(): SealBoard {
  const state = sealState()
  const pendingCandidates = state.candidates.filter((candidate) => candidate.state === 'pending')
  const sealedReceipts = state.candidates.filter((candidate) => candidate.state === 'sealed')
  const revokedCandidates = state.candidates.filter((candidate) => candidate.state === 'revoked')
  const archive = state.candidates.filter((candidate) => candidate.state === 'readonly')
  const drift = consistencyDrift(state)
  return {
    state,
    activePartitions: [...state.partitions],
    archive,
    pendingCandidates,
    sealedReceipts,
    revokedCandidates,
    drift,
    stats: {
      partitionTotal: state.partitions.length,
      revokedPartitionTotal: state.partitions.filter((part) => part.sealRev === null).length,
      pendingTotal: pendingCandidates.length,
      sealedTotal: sealedReceipts.length,
      revokedCandidateTotal: revokedCandidates.length,
      archiveTotal: archive.length,
      abnormalTotal:
        state.partitions.filter((part) => part.abnormal).length +
        state.candidates.filter((candidate) => candidate.abnormal).length,
      watermark: state.seqWatermark,
    },
  }
}

function consistencyDrift(state: SealState): SealBoard['drift'] {
  const drift: SealBoard['drift'] = []
  for (const candidate of state.candidates) {
    const part = state.partitions.find((item) => item.partCode === candidate.partCode)
    if (!part) continue
    if (candidate.snapshotRevokeSeq !== part.revokeSeq) {
      drift.push({
        partCode: part.partCode,
        govCode: candidate.govCode,
        detail: `${candidate.govCode} 快照 seq=${candidate.snapshotRevokeSeq} ≠ 分区当前 seq=${part.revokeSeq}`,
      })
    }
  }
  return drift
}

export function resetSealCenter(): SealOpResult {
  resetSealStorage()
  return { ok: true, message: '封存版本治理已重置为初始断点现场', hits: [], retryable: false }
}
