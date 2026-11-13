/**
 * 封存版本治理（seal revocation）领域类型。
 *
 * 模型主线：分区策略（partition，主对象）沿 partition→govern 引用边，把封存版本
 * seal_rev / revoke_seq 下发给存储治理（govern）候选。
 * - pending 候选：分区版本被吊销时立即 revoke；
 * - 已封存 receipt：只读，进入 archive=readonly 区，状态不再被改写；
 * - seal / unseal 交叉时以分区上的 revoke_seq 作为唯一版本，旧快照不得复活任何 pending 计划。
 */

/** 候选封存状态。 */
export type SealCandidateState =
  | 'pending' // 待封存（pending 计划，可被立即吊销）
  | 'sealed' // 已封存（receipt，只读）
  | 'revoked' // 已吊销（来自当前/旧版本，pending 立即吊销后的终态）
  | 'readonly' // 已封存后随分区版本吊销，迁入 archive=readonly 只读区

/** 分区封存实体：封存版本以分区策略为主对象。 */
export type PartitionSeal = {
  id: number
  /** 分区方案编号，如 PART-0001。 */
  partCode: string
  /** 分区方案名称/目标表名（回看分区窗口用）。 */
  partName: string
  /** 分区窗口：起。 */
  windowStart: string
  /** 分区窗口：止。 */
  windowEnd: string
  /** 分区字段。 */
  partitionField: string
  /** 封存版本号（印章版本）；为 null 表示当前无有效封存版本（已吊销）。 */
  sealRev: string | null
  /** 吊销单调序号，seal/unseal 交叉时的唯一版本判定依据。 */
  revokeSeq: number
  /** 是否处于异常态（概览异常牌回收的依据）。 */
  abnormal: boolean
  /** 最近一次变更说明。 */
  lastNote: string
}

/** 治理候选：govern 侧沿引用边持有的封存/吊销记录。 */
export type GovernCandidate = {
  id: number
  /** 治理策略编号，如 GOV-0001。 */
  govCode: string
  /** 引用的分区方案编号（partition→govern 引用边）。 */
  partCode: string
  /** 目标表名。 */
  tableName: string
  /** 治理类型，如 retain（保留）。 */
  governType: string
  /** 候选持有的保留/治理参数，如 retain=90。 */
  retainDays: number
  /** 候选状态。 */
  state: SealCandidateState
  /** 候选快照里记录的封存版本；旧快照可能与分区当前 seal_rev 不一致。 */
  snapshotSealRev: string | null
  /** 候选快照里记录的吊销序号。 */
  snapshotRevokeSeq: number
  /** 仅 sealed/readonly 有值：封存回执编号。 */
  receiptNo: string | null
  /** 只读标记：已封存 receipt 一律只读。 */
  readonly: boolean
  /** 是否处于异常态。 */
  abnormal: boolean
  /** 最近一次变更说明。 */
  lastNote: string
}

/** 证据事件：下发、封存、启封、失败、中断恢复都留痕。 */
export type SealEvent = {
  id: number
  /** 事件时间（ISO 字符串）。 */
  at: string
  /** 事件类型。 */
  kind:
    | 'propagate' // 沿引用边下发吊销
    | 'seal' // 封存
    | 'unseal' // 启封
    | 'revoke' // pending 候选立即吊销
    | 'archive' // receipt 迁入只读归档
    | 'reclaim' // 异常牌回收
    | 'no-hit' // 未命中
    | 'failure' // 失败（留异常原因）
    | 'retry' // 失败后重试
    | 'recover' // 中断恢复
    | 'check' // 一致性核对
    | 'reset'
  /** 涉及的分区方案编号（可空）。 */
  partCode: string | null
  /** 涉及的治理策略编号（可空）。 */
  govCode: string | null
  /** 当时的封存版本。 */
  sealRev: string | null
  /** 当时的吊销序号。 */
  revokeSeq: number
  ok: boolean
  message: string
}

/** 中断事务：写一半被打断时的恢复证据。 */
export type PendingTx = {
  op: 'propagate' | 'seal' | 'unseal'
  partCode: string
  govCode: string | null
  expectedSeq: number
  startedAt: string
  step: string
}

/** 封存版本治理整体持久化状态。 */
export type SealState = {
  partitions: PartitionSeal[]
  candidates: GovernCandidate[]
  events: SealEvent[]
  /** 当前吊销序号水位。 */
  seqWatermark: number
  /** 故障注入开关：打开后下一次写操作会失败，用于演示失败可重试。 */
  faultArmed: boolean
  /** 中断事务，非空表示上次操作被打断、等待恢复。 */
  pendingTx: PendingTx | null
}

/** 服务层统一返回：失败可重试，带说明与证据。 */
export type SealOpResult = {
  ok: boolean
  message: string
  /** 命中的候选编号列表；未命中时为空并附说明。 */
  hits: string[]
  /** 是否因故障注入/中断失败，可重试。 */
  retryable: boolean
}

/** 看板汇总：只统计当前 revoke_seq 的有效数据，异常牌已回收。 */
export type SealBoard = {
  state: SealState
  activePartitions: PartitionSeal[]
  archive: GovernCandidate[]
  pendingCandidates: GovernCandidate[]
  sealedReceipts: GovernCandidate[]
  revokedCandidates: GovernCandidate[]
  stats: {
    partitionTotal: number
    revokedPartitionTotal: number
    pendingTotal: number
    sealedTotal: number
    revokedCandidateTotal: number
    archiveTotal: number
    abnormalTotal: number
    watermark: number
  }
  /** 一致性核对结果：侧栏列表与详情页是否同源。 */
  drift: { partCode: string; govCode: string; detail: string }[]
}
