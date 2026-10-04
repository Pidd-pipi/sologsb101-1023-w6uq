/**
 * 回收区（Archive）：误移山场 / 批次时的可恢复归档
 * - 移入：把山场或批次连同六个工序表的关联记录整包放入 archives 表，保留原顺序与引用，随后从正式表移除
 * - 恢复：整包写回正式表；同编号（同 id）对象已存在时不覆盖，列出新旧工艺供人取舍
 * - 容量：明细（关联记录行）满 ARCHIVE_DETAIL_LIMIT 条后拒绝新移入，提示先清理
 * - 清理：删除归档包（彻底丢弃）或恢复后由调用方移除
 */
import type { Garden } from './garden';
import type { Batch } from './batch';
import type { Turn } from './turn';
import type { Fix } from './fix';
import type { Roast } from './roast';
import type { Review } from './review';

/** 回收区容量上限：按明细行数计（山场包 = 1 山场 + 批次 + 轮次 + 杀青 + 焙火 + 审评） */
export const ARCHIVE_DETAIL_LIMIT = 300;

/** 归档来源类型：移走山场 / 移走茶青批次 */
export const ARCHIVE_KINDS = ['garden', 'batch'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/** 归档来源中文文案 */
export const ARCHIVE_KIND_LABEL: Record<ArchiveKind, string> = {
  garden: '山场',
  batch: '茶青批次',
};

/** 六个工序表名（归档明细与校验共用，顺序即恢复写回顺序：先父后子） */
export const ARCHIVE_TABLES = ['garden', 'batches', 'turns', 'fixes', 'roasts', 'reviews'] as const;
export type ArchiveTableKey = (typeof ARCHIVE_TABLES)[number];

/** 归档包：一次「移走」操作的完整快照 */
export interface ArchivePackage {
  /** 回收区记录主键 */
  id: string;
  /** 归档类型：移走山场（含其下批次与工序记录）/ 移走单个批次 */
  kind: ArchiveKind;
  /** 被归档主体的展示名（山场名 / 批次标签快照），列表不 JOIN 也能展示 */
  subjectName: string;
  /** 主体 id（garden.id 或 batch.id） */
  subjectId: string;
  /** 山场本体；kind=batch 时为该批次所属山场的引用快照，可能为 null */
  garden: Garden | null;
  /** 批次列表：山场归档时为其全部批次，批次归档时仅该批次 */
  batches: Batch[];
  /** 做青轮次：保持 roundNo 升序（保留原顺序与 batchId 引用） */
  turns: Turn[];
  /** 杀青揉捻 */
  fixes: Fix[];
  /** 焙火道次：保持 passNo 升序 */
  roasts: Roast[];
  /** 审评记录 */
  reviews: Review[];
  /** 明细行数（= 1 山场 + 批次 + 轮次 + 杀青 + 焙火 + 审评，山场归档含山场行） */
  detailCount: number;
  /** 移入时间 ISO */
  archivedAt: string;
  /** 备注，例如级联的批次数量摘要 */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建归档包草稿（落库前结构，id 由持久化层补） */
export type ArchivePackageDraft = Omit<ArchivePackage, 'id'>;

/** 明细行数统计 */
export function archiveDetailCount(pkg: Pick<ArchivePackage, 'garden' | 'batches' | 'turns' | 'fixes' | 'roasts' | 'reviews'>): number {
  return (
    (pkg.garden ? 1 : 0) +
    pkg.batches.length +
    pkg.turns.length +
    pkg.fixes.length +
    pkg.roasts.length +
    pkg.reviews.length
  );
}

/** 归档包内各类明细计数（回收区列表展示用） */
export function archiveBreakdown(pkg: ArchivePackage): Record<ArchiveTableKey, number> {
  return {
    garden: pkg.garden ? 1 : 0,
    batches: pkg.batches.length,
    turns: pkg.turns.length,
    fixes: pkg.fixes.length,
    roasts: pkg.roasts.length,
    reviews: pkg.reviews.length,
  };
}

/** 单个对象的冲突情况（恢复时同 id 已存在） */
export interface ArchiveConflictItem {
  table: ArchiveTableKey;
  id: string;
  /** 归档里的旧记录（JSON 快照） */
  archived: unknown;
  /** 正式表里的现有记录（JSON 快照） */
  existing: unknown;
}

/** 恢复预检结果 */
export interface RestorePlan {
  packageId: string;
  /** 与现有正式数据主键冲突的对象 */
  conflicts: ArchiveConflictItem[];
  /** 可直接写回、不冲突的对象计数（按表） */
  cleanCounts: Record<ArchiveTableKey, number>;
  /** 是否存在任何冲突 */
  hasConflicts: boolean;
}

/** 恢复取舍：冲突对象选旧（归档）还是新（现有） */
export type RestoreChoice = 'archived' | 'existing';

/** 冲突取舍表：key = `${table}:${id}`，archived=用归档覆盖，existing=保留现有跳过 */
export type RestoreChoices = Record<string, RestoreChoice>;

/** 冲突项的选择键 */
export function conflictKey(table: ArchiveTableKey, id: string): string {
  return `${table}:${id}`;
}
