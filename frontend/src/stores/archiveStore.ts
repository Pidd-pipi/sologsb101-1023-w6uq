/**
 * 回收区状态管理（Zustand）· archiveStore.ts
 * 维护归档包列表、容量占用、恢复预检（新旧冲突取舍）与彻底清理。
 * 移入动作在 gardenStore / batchStore 完成后调用 refresh() 同步本 store。
 */
import { create } from 'zustand';
import {
  ARCHIVE_DETAIL_LIMIT,
  archiveBatch,
  archiveGarden,
  clearArchives,
  countArchiveDetails,
  listArchives,
  planRestore,
  removeArchive,
  restoreArchive,
} from '../utils/db';
import {
  archiveDetailCount,
  type ArchivePackage,
  type RestoreChoices,
  type RestorePlan,
} from '../types/archive';

/** 容量上限（明细行数），从类型常量透出供页面展示 */
export { ARCHIVE_DETAIL_LIMIT };

interface ArchiveStoreState {
  packages: ArchivePackage[];
  /** 回收区当前已占明细行数 */
  usedDetails: number;
  loading: boolean;
  error: string;
  initialized: boolean;
  refresh: () => Promise<void>;
  /** 移走山场（整包入回收区）；容量满抛 ArchiveQuotaError */
  moveGarden: (gardenId: string) => Promise<ArchivePackage>;
  /** 移走批次（整包入回收区） */
  moveBatch: (batchId: string) => Promise<ArchivePackage>;
  /** 恢复预检：列出同编号冲突与可直接写回数量 */
  inspect: (archiveId: string) => Promise<RestorePlan>;
  /** 恢复：冲突项按 choices 取舍（默认保留现有），成功后归档包出区 */
  restore: (archiveId: string, choices?: RestoreChoices) => Promise<RestorePlan>;
  /** 彻底删除单个归档包（清理腾容量） */
  purge: (archiveId: string) => Promise<void>;
  /** 清空回收区 */
  purgeAll: () => Promise<void>;
}

/** 统计归档包列表的明细总数 */
export function sumDetails(packages: ArchivePackage[]): number {
  return packages.reduce((acc, pkg) => acc + archiveDetailCount(pkg), 0);
}

export const useArchiveStore = create<ArchiveStoreState>((set, get) => ({
  packages: [],
  usedDetails: 0,
  loading: false,
  error: '',
  initialized: false,

  async refresh() {
    set({ loading: true, error: '' });
    try {
      const packages = await listArchives();
      const usedDetails = await countArchiveDetails();
      set({ packages, usedDetails, loading: false, initialized: true });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '回收区读取失败' });
    }
  },

  async moveGarden(gardenId) {
    const pkg = await archiveGarden(gardenId);
    await get().refresh();
    return pkg;
  },

  async moveBatch(batchId) {
    const pkg = await archiveBatch(batchId);
    await get().refresh();
    return pkg;
  },

  async inspect(archiveId) {
    return planRestore(archiveId);
  },

  async restore(archiveId, choices = {}) {
    const plan = await restoreArchive(archiveId, choices);
    await get().refresh();
    return plan;
  },

  async purge(archiveId) {
    await removeArchive(archiveId);
    await get().refresh();
  },

  async purgeAll() {
    await clearArchives();
    await get().refresh();
  },
}));

export default useArchiveStore;
