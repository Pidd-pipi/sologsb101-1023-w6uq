/**
 * 可恢复归档（Archive）：山场 / 批次被移走时，六个工序表的关联记录整体放入回收区。
 * - 一次归档（山场或批次）形成一个归档组（archiveGroupId 相同），组内保留原顺序与外键引用
 * - 回收区明细总条数达到 ARCHIVE_DETAIL_CAP（300）后拒绝新移入，必须先清理
 * - 恢复时按原主键写回正式表；同编号对象已存在则列出新旧工艺供人取舍，默认不覆盖
 */

/** 六个工序表名（归档明细的来源表，顺序即父→子层级） */
export const ARCHIVE_TABLES = ['gardens', 'batches', 'turns', 'fixes', 'roasts', 'reviews'] as const;
export type ArchiveTable = (typeof ARCHIVE_TABLES)[number];

/** 顶层归档对象类型（由哪个入口移走的） */
export const ARCHIVE_KINDS = ['garden', 'batch'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/** 回收区容量上限：明细条数（六个工序表的归档行合计）满 300 后拒绝新移入 */
export const ARCHIVE_DETAIL_CAP = 300;

/** 表名 → 中文名 / 单条量词 */
export const ARCHIVE_TABLE_LABEL: Record<ArchiveTable, string> = {
  gardens: '山场',
  batches: '茶青批次',
  turns: '做青轮次',
  fixes: '杀青揉捻',
  roasts: '焙火道次',
  reviews: '审评',
};

/** 归档明细实体（持久化到 IndexedDB 的 archives 表） */
export interface ArchiveRecord {
  id: string;
  /** 所属归档组 id：同一次移走的山场 / 批次及其全部关联明细共享一个组 id */
  archiveGroupId: string;
  /** 归档组来源类型：移走山场 / 移走批次 */
  kind: ArchiveKind;
  /** 顶层对象名（山场名 / 批次标签快照），列表展示用，避免关联行缺失后无法命名 */
  rootLabel: string;
  /** 明细来源表 */
  table: ArchiveTable;
  /** 原始行完整快照（保留原主键 id、roundNo / passNo 顺序与 batchId / gardenId 引用） */
  payload: Record<string, unknown>;
  /** 组内顺序：父对象在前、子表按原 roundNo / passNo / 日期排列，恢复时按此序回放 */
  seq: number;
  archivedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 归档组的聚合视图（回收区按组展示） */
export interface ArchiveGroupSummary {
  archiveGroupId: string;
  kind: ArchiveKind;
  rootLabel: string;
  archivedAt: string;
  /** 各表明细数 */
  counts: Record<ArchiveTable, number>;
  /** 明细总条数 */
  detailCount: number;
}

/** 恢复冲突取舍：保留现网（默认）/ 用归档覆盖 */
export type RestoreChoice = 'keep-live' | 'take-archived';

/** 一条冲突明细：同编号对象在正式表已存在 */
export interface RestoreConflict {
  archiveId: string;
  table: ArchiveTable;
  /** 归档行（旧工艺） */
  archived: Record<string, unknown>;
  /** 正式表现行（新工艺） */
  live: Record<string, unknown>;
  /** 人的取舍，默认保留现网（不覆盖） */
  choice: RestoreChoice;
}

/** 恢复预检结果：无冲突可直接恢复；有冲突先弹窗列新旧工艺 */
export interface RestorePlan {
  archiveGroupId: string;
  records: ArchiveRecord[];
  conflicts: RestoreConflict[];
}

/** 恢复执行结果（事务提交后返回，用于提示） */
export interface RestoreResult {
  restored: number;
  /** 选择「保留现网」而继续留在回收区的明细数 */
  conflictKept: number;
}
