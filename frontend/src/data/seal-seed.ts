import type { SealState } from './seal-types'

/**
 * 封存版本治理的确定性播种数据。
 *
 * 复现题述「断点」现场：
 * - PART-0001 的 seal_rev 已置 null（revoke_seq=3），但 GOV-0001 仍持有 retain=90 的
 *   旧快照（snapshot 停在 revoke_seq=2）并继续产出封存名单（pending）；
 * - GOV-0002 已按旧版本封存出 receipt（只读）；
 * - 概览异常牌未回收（abnormal=true 挂在 PART-0001 / GOV-0001 上）。
 * PART-0002 / GOV-0003 作为正常对照，便于核对「未命中」与正常封存路径。
 */
export function buildSealSeed(): SealState {
  const baseAt = '2026-11-13T09:00:00.000Z'
  return {
    seqWatermark: 3,
    faultArmed: false,
    pendingTx: null,
    partitions: [
      {
        id: 1,
        partCode: 'PART-0001',
        partName: 'dwd_order_detail_df',
        windowStart: '2026-09-01',
        windowEnd: '2026-11-30',
        partitionField: 'dt',
        sealRev: null,
        revokeSeq: 3,
        abnormal: true,
        lastNote: '封存版本已吊销（seal_rev=null），等待沿引用边下发',
      },
      {
        id: 2,
        partCode: 'PART-0002',
        partName: 'dws_user_summary_di',
        windowStart: '2026-10-01',
        windowEnd: '2026-12-31',
        partitionField: 'dt',
        sealRev: 'SEAL-R2',
        revokeSeq: 1,
        abnormal: false,
        lastNote: '当前封存版本 SEAL-R2 有效',
      },
    ],
    candidates: [
      {
        id: 1,
        govCode: 'GOV-0001',
        partCode: 'PART-0001',
        tableName: 'dwd_order_detail_df',
        governType: 'retain',
        retainDays: 90,
        state: 'pending',
        snapshotSealRev: 'SEAL-R2',
        snapshotRevokeSeq: 2,
        receiptNo: null,
        readonly: false,
        abnormal: true,
        lastNote: '仍持 retain=90 旧快照（seq=2），与分区当前 seq=3 脱节',
      },
      {
        id: 2,
        govCode: 'GOV-0002',
        partCode: 'PART-0001',
        tableName: 'dwd_order_detail_df',
        governType: 'retain',
        retainDays: 90,
        state: 'sealed',
        snapshotSealRev: 'SEAL-R2',
        snapshotRevokeSeq: 2,
        receiptNo: 'RCPT-2026-0002',
        readonly: true,
        abnormal: false,
        lastNote: '已封存回执，按旧版本封存；版本吊销后应迁入只读归档',
      },
      {
        id: 3,
        govCode: 'GOV-0003',
        partCode: 'PART-0002',
        tableName: 'dws_user_summary_di',
        governType: 'retain',
        retainDays: 180,
        state: 'pending',
        snapshotSealRev: 'SEAL-R2',
        snapshotRevokeSeq: 1,
        receiptNo: null,
        readonly: false,
        abnormal: false,
        lastNote: '与分区当前版本一致，正常待封存',
      },
    ],
    events: [
      {
        id: 1,
        at: baseAt,
        kind: 'unseal',
        partCode: 'PART-0001',
        govCode: null,
        sealRev: null,
        revokeSeq: 3,
        ok: true,
        message: 'PART-0001 封存版本吊销，seal_rev 置 null；下游尚未下发，形成断点',
      },
    ],
  }
}
