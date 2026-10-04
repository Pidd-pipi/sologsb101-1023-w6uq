/**
 * 回收区状态管理（Zustand）· archiveStore.ts
 * 维护归档分组列表、容量占用、恢复预检计划与恢复冲突取舍。
 * 归档写入仍由 gardenStore / batchStore 的删除动作触发（utils/db 层事务）。
 */
import { create } from 'zustand';
import {
  countArchiveDetails,
  listArchiveGroups,
  planRestoreArchive,
  purgeAllArchives,
  purgeArchiveGroup,
  restoreArchiveGroup,
} from '../utils/db';
import { ARCHIVE_DETAIL_CAP, type ArchiveGroupSummary, type RestoreChoice, type RestorePlan } from '../types/archive';

interface ArchiveStoreState {
  groups: ArchiveGroupSummary[];
  detailCount: number;
  loading: boolean;
  error: string;
  /** 恢复预检计划（点「恢复」时载入，弹窗列冲突新旧工艺） */
  plan: RestorePlan | null;
  planLoading: boolean;
  /** 冲突取舍：archiveId → choice（默认保留现网） */
  choices: Record<string, RestoreChoice>;
  restoring: boolean;
  loadArchives: () => Promise<void>;
  openRestorePlan: (groupId: string) => Promise<RestorePlan | null>;
  closeRestorePlan: () => void;
  setChoice: (archiveId: string, choice: RestoreChoice) => void;
  confirmRestore: () => Promise<{ restored: number; conflictKept: number } | null>;
  purgeGroup: (groupId: string) => Promise<void>;
  purgeAll: () => Promise<void>;
}

export const useArchiveStore = create<ArchiveStoreState>((set, get) => ({
  groups: [],
  detailCount: 0,
  loading: false,
  error: '',
  plan: null,
  planLoading: false,
  choices: {},
  restoring: false,

  async loadArchives() {
    set({ loading: true, error: '' });
    try {
      const [groups, detailCount] = await Promise.all([listArchiveGroups(), countArchiveDetails()]);
      set({ groups, detailCount, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '回收区读取失败' });
    }
  },

  async openRestorePlan(groupId) {
    set({ planLoading: true, error: '' });
    try {
      const plan = await planRestoreArchive(groupId);
      const choices = plan.conflicts.reduce<Record<string, RestoreChoice>>((acc, conflict) => {
        acc[conflict.archiveId] = 'keep-live';
        return acc;
      }, {});
      set({ plan, choices, planLoading: false });
      return plan;
    } catch (error) {
      set({ planLoading: false, error: error instanceof Error ? error.message : '恢复预检失败' });
      return null;
    }
  },

  closeRestorePlan() {
    set({ plan: null, choices: {} });
  },

  setChoice(archiveId, choice) {
    set({ choices: { ...get().choices, [archiveId]: choice } });
  },

  async confirmRestore() {
    const plan = get().plan;
    if (!plan || get().restoring) return null;
    set({ restoring: true, error: '' });
    try {
      // 单事务回放：中途失败由 Dexie 回滚到恢复操作前状态
      const result = await restoreArchiveGroup(plan.archiveGroupId, get().choices);
      set({ plan: null, choices: {}, restoring: false });
      await get().loadArchives();
      return result;
    } catch (error) {
      set({ restoring: false, error: error instanceof Error ? error.message : '恢复失败，已回滚到恢复前状态' });
      throw error;
    }
  },

  async purgeGroup(groupId) {
    await purgeArchiveGroup(groupId);
    await get().loadArchives();
  },

  async purgeAll() {
    await purgeAllArchives();
    await get().loadArchives();
  },
}));

/** 剩余容量（明细条数） */
export function archiveCapacityLeft(detailCount: number): number {
  return Math.max(0, ARCHIVE_DETAIL_CAP - detailCount);
}

export { ARCHIVE_DETAIL_CAP };
export default useArchiveStore;
