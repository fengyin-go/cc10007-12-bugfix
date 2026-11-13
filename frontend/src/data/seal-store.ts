import { buildSealSeed } from './seal-seed'
import type { SealEvent, SealState } from './seal-types'

// 封存版本治理独立持久化键，与通用台账 data-layer-studio:entries 互不影响。
const SEAL_STORAGE_KEY = 'data-layer-studio:seal-revocation'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeStorage(state: SealState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SEAL_STORAGE_KEY, JSON.stringify(state))
  }
}

function readStorage(): SealState {
  const fallback = buildSealSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(SEAL_STORAGE_KEY)
  if (!raw) {
    writeStorage(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as SealState
    return normalize(parsed)
  } catch {
    writeStorage(fallback)
    return fallback
  }
}

/** 补齐字段并在加载时处理上次遗留的中断事务（中断恢复留证据）。 */
function normalize(parsed: SealState): SealState {
  const base = buildSealSeed()
  const state: SealState = {
    partitions: parsed.partitions ?? base.partitions,
    candidates: parsed.candidates ?? base.candidates,
    events: parsed.events ?? base.events,
    seqWatermark: typeof parsed.seqWatermark === 'number' ? parsed.seqWatermark : base.seqWatermark,
    faultArmed: Boolean(parsed.faultArmed),
    pendingTx: parsed.pendingTx ?? null,
  }
  if (state.pendingTx) {
    const tx = state.pendingTx
    state.events.push({
      id: nextEventId(state.events),
      at: new Date().toISOString(),
      kind: 'recover',
      partCode: tx.partCode,
      govCode: tx.govCode,
      sealRev: null,
      revokeSeq: tx.expectedSeq,
      ok: true,
      message: `检测到中断事务（${tx.op}，停在步骤「${tx.step}」），已回滚到中断前快照，可重新发起`,
    })
    state.pendingTx = null
    writeStorage(state)
  }
  return state
}

export function nextEventId(events: SealEvent[]): number {
  return events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0) + 1
}

let cache: SealState | null = null

export function sealState(): SealState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function persistSeal(state: SealState): void {
  cache = state
  writeStorage(state)
}

export function resetSealStorage(): SealState {
  const fresh = buildSealSeed()
  persistSeal(fresh)
  return clone(fresh)
}

export function sealStorageKey(): string {
  return SEAL_STORAGE_KEY
}
