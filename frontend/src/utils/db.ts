/**
 * IndexedDB 持久化层（Dexie 封装）· 库名 gbtearock
 * - 结构版本号 version(1) 初版 + version(2) 索引/权重重算 + version(3) 回收区归档与审评失效字段
 * - 山场 / 茶青批次 / 做青轮次 / 杀青揉捻 / 焙火 / 审评 六张分表 + 回收区 archives 表
 * - 首屏自动播种互相引用的演示数据（山场 → 批次 → 轮次/杀青/焙火/审评 三层贯通）
 * - 纯前端应用：不依赖任何后端、数据库服务或外部接口
 */
import Dexie, { type Table } from 'dexie';
import { CULTIVAR_OPTIONS, SOIL_OPTIONS, type Garden } from '../types/garden';
import { BATCH_STATES, type Batch } from '../types/batch';
import { TURN_LIMITS, type Turn } from '../types/turn';
import type { Fix } from '../types/fix';
import { ROAST_STATES, type Roast } from '../types/roast';
import type { Review } from '../types/review';
import {
  ARCHIVE_DETAIL_LIMIT,
  archiveDetailCount,
  conflictKey,
  type ArchiveKind,
  type ArchivePackage,
  type ArchivePackageDraft,
  type ArchiveTableKey,
  type RestoreChoices,
  type RestorePlan,
} from '../types/archive';
import { clampScore, weightedTotalScore } from './tea';

/** 数据库名 = 英文短名 */
export const DB_NAME = 'gbtearock';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

/** 主键前缀，便于在导出 JSON 里肉眼区分实体 */
export const ID_PREFIX = {
  garden: 'garden',
  batch: 'batch',
  turn: 'turn',
  fix: 'fix',
  roast: 'roast',
  review: 'review',
  archive: 'archive',
} as const;

/** 回收区容量上限（明细行数） */
export { ARCHIVE_DETAIL_LIMIT };

/** 回收区容量已满：拒绝新移入时抛出，携带当前 / 本次明细数供页面提示清理 */
export class ArchiveQuotaError extends Error {
  currentCount: number;
  incomingCount: number;

  constructor(currentCount: number, incomingCount: number) {
    super(
      `回收区已存 ${currentCount} 条明细，本次移入需 ${incomingCount} 条，超过 ${ARCHIVE_DETAIL_LIMIT} 条上限，请先恢复或彻底清理部分归档`,
    );
    this.name = 'ArchiveQuotaError';
    this.currentCount = currentCount;
    this.incomingCount = incomingCount;
  }
}

class TeaRockDatabase extends Dexie {
  gardens!: Table<Garden, string>;
  batches!: Table<Batch, string>;
  turns!: Table<Turn, string>;
  fixes!: Table<Fix, string>;
  roasts!: Table<Roast, string>;
  reviews!: Table<Review, string>;
  archives!: Table<ArchivePackage, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（只保留最小索引，历史数据沿用 id 主键）
    this.version(1).stores({
      gardens: 'id, name, cultivar',
      batches: 'id, gardenId, state',
      turns: 'id, batchId, roundNo',
      fixes: 'id, batchId, operator',
      roasts: 'id, batchId, passNo, state',
      reviews: 'id, batchId, totalScore',
    });

    // v2：索引补齐（外键 / 状态 / 日期全部可查），并真实迁移历史数据：
    //     1) 补齐 createdAt / updatedAt；2) 山场补齐朝向、土壤与品种兜底值；
    //     3) 批次工序状态归一化；4) 轮次与焙火数值截断到合法区间；
    //     5) 审评总分由「四项简单平均」改为「分项加权换算」，迁移时按新权重重算。
    this.version(2)
      .stores({
        gardens: 'id, name, cultivar, soil, altitudeM, createdAt, updatedAt',
        batches: 'id, gardenId, pickedAt, state, tenderness, createdAt, updatedAt',
        turns: 'id, batchId, roundNo, [batchId+roundNo], createdAt, updatedAt',
        fixes: 'id, batchId, operator, createdAt, updatedAt',
        roasts: 'id, batchId, passNo, state, nextRoastDate, createdAt, updatedAt',
        reviews: 'id, batchId, reviewedAt, totalScore, createdAt, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        await tx
          .table<Garden, string>('gardens')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (!row.aspect) row.aspect = '未标注朝向';
            if (!Number.isFinite(row.altitudeM)) row.altitudeM = 0;
            if (!SOIL_OPTIONS.includes(row.soil)) row.soil = SOIL_OPTIONS[0];
            if (!CULTIVAR_OPTIONS.includes(row.cultivar)) row.cultivar = CULTIVAR_OPTIONS[0];
          });

        await tx
          .table<Batch, string>('batches')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (!BATCH_STATES.includes(row.state)) row.state = BATCH_STATES[0];
            if (!Number.isFinite(row.freshLeafKg) || row.freshLeafKg <= 0) row.freshLeafKg = 1;
            if (!row.pickedAt) row.pickedAt = stamp.slice(0, 10);
          });

        await tx
          .table<Turn, string>('turns')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (!Number.isFinite(row.roundNo) || row.roundNo < 1) row.roundNo = 1;
            row.shakeMin = clampNumber(row.shakeMin, TURN_LIMITS.shakeMin.min, TURN_LIMITS.shakeMin.max);
            row.restMin = clampNumber(row.restMin, TURN_LIMITS.restMin.min, TURN_LIMITS.restMin.max);
            row.roomTempC = clampNumber(row.roomTempC, TURN_LIMITS.roomTempC.min, TURN_LIMITS.roomTempC.max);
            row.humidityPct = clampNumber(row.humidityPct, TURN_LIMITS.humidityPct.min, TURN_LIMITS.humidityPct.max);
            row.waterLossPct = clampNumber(
              row.waterLossPct,
              TURN_LIMITS.waterLossPct.min,
              TURN_LIMITS.waterLossPct.max,
            );
          });

        await tx
          .table<Fix, string>('fixes')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (!row.operator) row.operator = '未署名';
            if (!Number.isFinite(row.wokTempC)) row.wokTempC = 180;
            if (!Number.isFinite(row.fixMin)) row.fixMin = 6;
            if (!Number.isFinite(row.rollMin)) row.rollMin = 10;
          });

        await tx
          .table<Roast, string>('roasts')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (!ROAST_STATES.includes(row.state)) row.state = ROAST_STATES[0];
            if (typeof row.nextRoastDate !== 'string') row.nextRoastDate = '';
            if (!Number.isFinite(row.passNo) || row.passNo < 1) row.passNo = 1;
            if (!Number.isFinite(row.tempC)) row.tempC = 90;
            if (!Number.isFinite(row.hours)) row.hours = 4;
          });

        await tx
          .table<Review, string>('reviews')
          .toCollection()
          .modify((row) => {
            if (!row.createdAt) row.createdAt = stamp;
            if (!row.updatedAt) row.updatedAt = row.createdAt;
            if (typeof row.blendNote !== 'string') row.blendNote = '';
            if (!row.reviewedAt) row.reviewedAt = stamp.slice(0, 10);
            row.aroma = clampScore(row.aroma);
            row.liquorColor = clampScore(row.liquorColor);
            row.taste = clampScore(row.taste);
            row.leafBase = clampScore(row.leafBase);
            // v2 起总分改为分项加权换算，历史数据按新权重重算
            row.totalScore = weightedTotalScore({
              aroma: row.aroma,
              liquorColor: row.liquorColor,
              taste: row.taste,
              leafBase: row.leafBase,
            });
          });
      });

    // v3：回收区归档表 + 审评「待复评失效」字段。
    //     旧库升级时补齐归档与失效字段：历史审评默认有效（invalid=false）。
    this.version(DB_VERSION)
      .stores({
        gardens: 'id, name, cultivar, soil, altitudeM, createdAt, updatedAt',
        batches: 'id, gardenId, pickedAt, state, tenderness, createdAt, updatedAt',
        turns: 'id, batchId, roundNo, [batchId+roundNo], createdAt, updatedAt',
        fixes: 'id, batchId, operator, createdAt, updatedAt',
        roasts: 'id, batchId, passNo, state, nextRoastDate, createdAt, updatedAt',
        reviews: 'id, batchId, reviewedAt, totalScore, invalid, invalidatedAt, createdAt, updatedAt',
        archives: 'id, kind, subjectId, archivedAt, detailCount',
      })
      .upgrade(async (tx) => {
        // 旧库升级补齐审评失效字段：历史审评分默认仍有效，等首次工艺参数变动再失效
        await tx
          .table<Review, string>('reviews')
          .toCollection()
          .modify((row) => {
            if (typeof row.invalid !== 'boolean') row.invalid = false;
            if (typeof row.invalidReason !== 'string') row.invalidReason = null;
            if (typeof row.invalidatedAt !== 'string') row.invalidatedAt = null;
          });
        // archives 为新增表，旧库无历史归档可迁移，保持空表
      });
  }
}

export const db = new TeaRockDatabase();

/** 补齐历史审评的失效字段（旧库升级后默认有效），幂等 */
async function backfillReviewInvalidFields(): Promise<void> {
  const rows = await db.reviews.toArray();
  const missing = rows.filter(
    (row) => typeof row.invalid !== 'boolean' || typeof row.invalidReason !== 'string' || typeof row.invalidatedAt !== 'string',
  );
  if (missing.length === 0) return;
  const stamp = nowIso();
  await db.reviews.bulkPut(
    missing.map((row) => ({
      ...row,
      invalid: false,
      invalidReason: null,
      invalidatedAt: null,
      updatedAt: stamp,
    })),
  );
}

/** 数值截断到区间内 */
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 生成主键：前缀 + 时间戳 + 随机串（浏览器优先使用 crypto.randomUUID） */
export function createId(prefix: string): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  const tail =
    cryptoObj && typeof cryptoObj.randomUUID === 'function'
      ? cryptoObj.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}${tail}`;
}

/** 相对今天偏移若干天的 YYYY-MM-DD（播种复焙提醒用） */
function shiftDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 回收区与六张正式表（归档 / 恢复 / 清空 / 导入共用的全量表集合） */
const ALL_TABLES = [
  db.gardens,
  db.batches,
  db.turns,
  db.fixes,
  db.roasts,
  db.reviews,
  db.archives,
] as const;

/* ------------------------------ 打开与播种 ------------------------------ */

/**
 * 打开数据库：首次使用时灌入演示数据，保证每个页面打开都有内容。
 * 六张正式表与回收区都为空才播种（避免用户把数据全部移入回收区后刷新又灌入演示数据）。
 */
export async function initDatabase(): Promise<void> {
  await db.open();
  // 旧库升级兜底：IndexedDB 对「只加字段」不触发行迁移，这里统一补齐失效字段（幂等）
  await backfillReviewInvalidFields();
  const [gardenCount, batchCount, archiveCount] = await Promise.all([
    db.gardens.count(),
    db.batches.count(),
    db.archives.count(),
  ]);
  if (gardenCount === 0 && batchCount === 0 && archiveCount === 0) {
    await seedDatabase();
  }
}

/** 幂等播种：固定 id + bulkPut，重复执行不会产生重复行 */
export async function seedDatabase(): Promise<void> {
  const stamp = nowIso();

  const gardens: Garden[] = [
    {
      id: 'garden-niulankeng',
      name: '牛栏坑',
      altitudeM: 285,
      soil: '砾壤',
      cultivar: '肉桂',
      aspect: '东南向',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'garden-huiyuankeng',
      name: '慧苑坑',
      altitudeM: 420,
      soil: '砾壤',
      cultivar: '水仙',
      aspect: '北向',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'garden-matouyan',
      name: '马头岩',
      altitudeM: 640,
      soil: '沙壤',
      cultivar: '肉桂',
      aspect: '南向',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const batches: Batch[] = [
    {
      id: 'batch-niulankeng-0426',
      gardenId: 'garden-niulankeng',
      pickedAt: '2025-04-26',
      freshLeafKg: 42.5,
      tenderness: '一芽三叶',
      weather: '晴，北风 2 级，晨露已干',
      state: '已审评',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'batch-huiyuankeng-0503',
      gardenId: 'garden-huiyuankeng',
      pickedAt: '2025-05-03',
      freshLeafKg: 58,
      tenderness: '开面采',
      weather: '多云，相对湿度 78%',
      state: '已审评',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'batch-matouyan-0508',
      gardenId: 'garden-matouyan',
      pickedAt: '2025-05-08',
      freshLeafKg: 36.8,
      tenderness: '一芽两叶',
      weather: '晴热，午后 29 ℃',
      state: '已焙火',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'batch-matouyan-0512',
      gardenId: 'garden-matouyan',
      pickedAt: '2025-05-12',
      freshLeafKg: 21.4,
      tenderness: '开面采',
      weather: '阴，间歇小雨，叶面有水',
      state: '做青中',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const turns: Turn[] = [
    turnSeed('turn-niu-1', 'batch-niulankeng-0426', 1, 4, 40, 23, 72, 4.5, stamp),
    turnSeed('turn-niu-2', 'batch-niulankeng-0426', 2, 6, 50, 24, 70, 9.2, stamp),
    turnSeed('turn-niu-3', 'batch-niulankeng-0426', 3, 8, 60, 25, 68, 15.6, stamp),
    turnSeed('turn-hui-1', 'batch-huiyuankeng-0503', 1, 5, 45, 22, 75, 3.8, stamp),
    turnSeed('turn-hui-2', 'batch-huiyuankeng-0503', 2, 8, 55, 23, 71, 9.6, stamp),
    turnSeed('turn-hui-3', 'batch-huiyuankeng-0503', 3, 10, 70, 24, 66, 17.2, stamp),
    turnSeed('turn-matou-1', 'batch-matouyan-0508', 1, 3, 35, 21, 78, 3.2, stamp),
    turnSeed('turn-matou-2', 'batch-matouyan-0508', 2, 5, 45, 22, 74, 8.4, stamp),
    turnSeed('turn-matou-3', 'batch-matouyan-0512', 1, 6, 50, 24, 70, 4.1, stamp),
    turnSeed('turn-matou-4', 'batch-matouyan-0512', 2, 9, 60, 25, 68, 10.8, stamp),
  ];

  const fixes: Fix[] = [
    {
      id: 'fix-niulankeng',
      batchId: 'batch-niulankeng-0426',
      wokTempC: 180,
      fixMin: 6,
      rollPressure: '中',
      rollMin: 12,
      operator: '陈水金',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'fix-huiyuankeng',
      batchId: 'batch-huiyuankeng-0503',
      wokTempC: 165,
      fixMin: 7,
      rollPressure: '轻',
      rollMin: 15,
      operator: '陈水金',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'fix-matouyan',
      batchId: 'batch-matouyan-0508',
      wokTempC: 195,
      fixMin: 5,
      rollPressure: '重',
      rollMin: 8,
      operator: '林清和',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const roasts: Roast[] = [
    {
      id: 'roast-niu-pass1',
      batchId: 'batch-niulankeng-0426',
      passNo: 1,
      tempC: 110,
      hours: 8,
      charcoal: '荔枝炭',
      nextRoastDate: '',
      state: '已足火',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'roast-niu-pass2',
      batchId: 'batch-niulankeng-0426',
      passNo: 2,
      tempC: 120,
      hours: 6,
      charcoal: '荔枝炭',
      nextRoastDate: shiftDate(-2),
      state: '已足火',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'roast-hui-pass1',
      batchId: 'batch-huiyuankeng-0503',
      passNo: 1,
      tempC: 95,
      hours: 5,
      charcoal: '龙眼炭',
      nextRoastDate: shiftDate(3),
      state: '焙火中',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'roast-hui-pass2',
      batchId: 'batch-huiyuankeng-0503',
      passNo: 2,
      tempC: 100,
      hours: 4,
      charcoal: '机制炭',
      nextRoastDate: '',
      state: '待焙',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const reviewSeed: Array<Omit<Review, 'totalScore' | 'invalid' | 'invalidReason' | 'invalidatedAt'>> = [
    {
      id: 'review-niulankeng',
      batchId: 'batch-niulankeng-0426',
      reviewedAt: '2025-07-12',
      aroma: 93,
      liquorColor: 90,
      taste: 92,
      leafBase: 89,
      blendNote: '拼配方案 A · 占 35%',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'review-huiyuankeng',
      batchId: 'batch-huiyuankeng-0503',
      reviewedAt: '2025-07-18',
      aroma: 88,
      liquorColor: 85,
      taste: 87,
      leafBase: 84,
      blendNote: '拼配方案 A · 占 40%',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'review-matouyan',
      batchId: 'batch-matouyan-0508',
      reviewedAt: '2025-07-25',
      aroma: 80,
      liquorColor: 82,
      taste: 78,
      leafBase: 79,
      blendNote: '待定，退火后复评',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  const reviews: Review[] = reviewSeed.map((row) => ({
    ...row,
    totalScore: weightedTotalScore({
      aroma: row.aroma,
      liquorColor: row.liquorColor,
      taste: row.taste,
      leafBase: row.leafBase,
    }),
    invalid: false,
    invalidReason: null,
    invalidatedAt: null,
  }));

  await db.transaction('rw', [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews], async () => {
    if ((await db.gardens.count()) === 0) await db.gardens.bulkPut(gardens);
    if ((await db.batches.count()) === 0) await db.batches.bulkPut(batches);
    if ((await db.turns.count()) === 0) await db.turns.bulkPut(turns);
    if ((await db.fixes.count()) === 0) await db.fixes.bulkPut(fixes);
    if ((await db.roasts.count()) === 0) await db.roasts.bulkPut(roasts);
    if ((await db.reviews.count()) === 0) await db.reviews.bulkPut(reviews);
  });
}

/** 播种用的轮次构造器，避免重复字段声明 */
function turnSeed(
  id: string,
  batchId: string,
  roundNo: number,
  shakeMin: number,
  restMin: number,
  roomTempC: number,
  humidityPct: number,
  waterLossPct: number,
  stamp: string,
): Turn {
  return {
    id,
    batchId,
    roundNo,
    shakeMin,
    restMin,
    roomTempC,
    humidityPct,
    waterLossPct,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/* ------------------------------- 山场 ------------------------------- */

export async function listGardens(): Promise<Garden[]> {
  const rows = await db.gardens.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getGarden(id: string): Promise<Garden | undefined> {
  return db.gardens.get(id);
}

export async function putGarden(row: Garden): Promise<void> {
  await db.gardens.put(row);
}

/* ------------------------------ 茶青批次 ------------------------------ */

export async function listBatches(): Promise<Batch[]> {
  const rows = await db.batches.toArray();
  return rows.sort((a, b) => b.pickedAt.localeCompare(a.pickedAt));
}

export async function listBatchesByGarden(gardenId: string): Promise<Batch[]> {
  const rows = await db.batches.where('gardenId').equals(gardenId).toArray();
  return rows.sort((a, b) => b.pickedAt.localeCompare(a.pickedAt));
}

export async function getBatch(id: string): Promise<Batch | undefined> {
  return db.batches.get(id);
}

export async function putBatch(row: Batch): Promise<void> {
  await db.batches.put(row);
}

export async function putBatches(rows: Batch[]): Promise<void> {
  await db.batches.bulkPut(rows);
}

/* ------------------------------ 做青轮次 ------------------------------ */

export async function listTurnsByBatch(batchId: string): Promise<Turn[]> {
  const rows = await db.turns.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.roundNo - b.roundNo);
}

export async function listAllTurns(): Promise<Turn[]> {
  const rows = await db.turns.toArray();
  return rows.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.roundNo - b.roundNo);
}

export async function putTurn(row: Turn): Promise<void> {
  await db.turns.put(row);
}

export async function putTurns(rows: Turn[]): Promise<void> {
  await db.turns.bulkPut(rows);
}

export async function removeTurn(id: string): Promise<void> {
  await db.turns.delete(id);
}

/* ----------------------------- 杀青揉捻 ----------------------------- */

export async function listFixes(): Promise<Fix[]> {
  const rows = await db.fixes.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listFixesByBatch(batchId: string): Promise<Fix[]> {
  return db.fixes.where('batchId').equals(batchId).toArray();
}

export async function putFix(row: Fix): Promise<void> {
  await db.fixes.put(row);
}

export async function removeFix(id: string): Promise<void> {
  await db.fixes.delete(id);
}

/* -------------------------------- 焙火 -------------------------------- */

export async function listRoasts(): Promise<Roast[]> {
  const rows = await db.roasts.toArray();
  return rows.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.passNo - b.passNo);
}

export async function listRoastsByBatch(batchId: string): Promise<Roast[]> {
  const rows = await db.roasts.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.passNo - b.passNo);
}

export async function putRoast(row: Roast): Promise<void> {
  await db.roasts.put(row);
}

export async function putRoasts(rows: Roast[]): Promise<void> {
  await db.roasts.bulkPut(rows);
}

export async function removeRoast(id: string): Promise<void> {
  await db.roasts.delete(id);
}

/* -------------------------------- 审评 -------------------------------- */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray();
  return rows.sort((a, b) => b.totalScore - a.totalScore);
}

export async function listReviewsByBatch(batchId: string): Promise<Review[]> {
  const rows = await db.reviews.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put(row);
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id);
}

/**
 * 工艺参数变动 → 相关批次的审评分与拼配候选失效（待复评）。
 * 在做青 / 杀青 / 焙火参数新增、修改、删除时调用；只标记已有审评，返回失效条数。
 */
export async function invalidateReviewsForBatches(batchIds: string[], reason: string): Promise<number> {
  const ids = [...new Set(batchIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const stamp = nowIso();
  let affected = 0;
  await db.transaction('rw', db.reviews, async () => {
    const rows = await db.reviews.where('batchId').anyOf(ids).toArray();
    const stale = rows.filter((row) => !row.invalid);
    if (stale.length === 0) return;
    await db.reviews.bulkPut(
      stale.map((row) => ({
        ...row,
        invalid: true,
        invalidReason: reason,
        invalidatedAt: stamp,
        updatedAt: stamp,
      })),
    );
    affected = stale.length;
  });
  return affected;
}

/* ----------------------------- 回收区归档 ----------------------------- */

/** 回收区全部归档包（最近移入在前） */
export async function listArchives(): Promise<ArchivePackage[]> {
  const rows = await db.archives.toArray();
  return rows.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export async function getArchive(id: string): Promise<ArchivePackage | undefined> {
  return db.archives.get(id);
}

/** 回收区当前明细总数（容量判定用） */
export async function countArchiveDetails(): Promise<number> {
  const packages = await db.archives.toArray();
  return packages.reduce((acc, pkg) => acc + pkg.detailCount, 0);
}

/** 组装归档包：抓取主体及其六个工序表关联记录，保留 roundNo / passNo 原顺序与外键引用 */
async function collectGardenPackage(gardenId: string): Promise<ArchivePackageDraft | null> {
  const garden = await db.gardens.get(gardenId);
  if (!garden) return null;
  const batches = await listBatchesByGarden(gardenId);
  const batchIds = batches.map((batch) => batch.id);
  const [turns, fixes, roasts, reviews] = await collectProcessRows(batchIds);
  const stamp = nowIso();
  const draft: ArchivePackageDraft = {
    kind: 'garden',
    subjectName: garden.name,
    subjectId: garden.id,
    garden,
    batches,
    turns,
    fixes,
    roasts,
    reviews,
    detailCount: 0,
    archivedAt: stamp,
    summary: `山场「${garden.name}」：${batches.length} 个批次，轮次 ${turns.length} / 杀青 ${fixes.length} / 焙火 ${roasts.length} / 审评 ${reviews.length}`,
    createdAt: stamp,
    updatedAt: stamp,
  };
  draft.detailCount = archiveDetailCount(draft);
  return draft;
}

async function collectBatchPackage(batchId: string): Promise<ArchivePackageDraft | null> {
  const batch = await db.batches.get(batchId);
  if (!batch) return null;
  const garden = (await db.gardens.get(batch.gardenId)) ?? null;
  const [turns, fixes, roasts, reviews] = await collectProcessRows([batchId]);
  const stamp = nowIso();
  const gardenName = garden ? `${garden.name} · ` : '';
  const draft: ArchivePackageDraft = {
    kind: 'batch',
    subjectName: `${gardenName}${batch.pickedAt} · ${batch.tenderness}`,
    subjectId: batch.id,
    garden,
    batches: [batch],
    turns,
    fixes,
    roasts,
    reviews,
    detailCount: 0,
    archivedAt: stamp,
    summary: `批次「${gardenName}${batch.pickedAt}」：轮次 ${turns.length} / 杀青 ${fixes.length} / 焙火 ${roasts.length} / 审评 ${reviews.length}`,
    createdAt: stamp,
    updatedAt: stamp,
  };
  draft.detailCount = archiveDetailCount(draft);
  return draft;
}

/** 抓批次下的工序子表（顺序在查询函数内已排好） */
async function collectProcessRows(
  batchIds: string[],
): Promise<[Turn[], Fix[], Roast[], Review[]]> {
  if (batchIds.length === 0) return [[], [], [], []];
  const [allTurns, allFixes, allRoasts, allReviews] = await Promise.all([
    db.turns.where('batchId').anyOf(batchIds).toArray(),
    db.fixes.where('batchId').anyOf(batchIds).toArray(),
    db.roasts.where('batchId').anyOf(batchIds).toArray(),
    db.reviews.where('batchId').anyOf(batchIds).toArray(),
  ]);
  return [
    allTurns.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.roundNo - b.roundNo),
    allFixes.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.createdAt.localeCompare(b.createdAt)),
    allRoasts.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.passNo - b.passNo),
    allReviews.sort((a, b) => a.batchId.localeCompare(b.batchId) || a.reviewedAt.localeCompare(b.reviewedAt)),
  ];
}

/**
 * 移走入回收区的通用事务：校验容量 → 写归档包 → 删正式表。
 * 任一步失败整个事务回滚：正式数据不会丢、回收区不会出现半包。
 */
async function archiveDraft(draft: ArchivePackageDraft): Promise<ArchivePackage> {
  return db.transaction('rw', ALL_TABLES, async () => {
    const used = await db.archives.toArray();
    const currentDetails = used.reduce((acc, pkg) => acc + pkg.detailCount, 0);
    if (currentDetails + draft.detailCount > ARCHIVE_DETAIL_LIMIT) {
      throw new ArchiveQuotaError(currentDetails, draft.detailCount);
    }
    const stamp = nowIso();
    const pkg: ArchivePackage = {
      ...draft,
      id: createId(ID_PREFIX.archive),
      updatedAt: stamp,
    };    await db.archives.put(pkg);
    await deleteLiveRows(draft.kind, draft.subjectId, draft.batches.map((batch) => batch.id));
    return pkg;
  });
}

/** 从事务内删除主体在正式表的关联行 */
async function deleteLiveRows(kind: ArchiveKind, subjectId: string, batchIds: string[]): Promise<void> {
  if (batchIds.length > 0) {
    await db.turns.where('batchId').anyOf(batchIds).delete();
    await db.fixes.where('batchId').anyOf(batchIds).delete();
    await db.roasts.where('batchId').anyOf(batchIds).delete();
    await db.reviews.where('batchId').anyOf(batchIds).delete();
    await db.batches.where('id').anyOf(batchIds).delete();
  }
  if (kind === 'garden') await db.gardens.delete(subjectId);
}

/** 移走山场：山场本体 + 其批次 + 六张工序表关联记录整包入回收区 */
export async function archiveGarden(gardenId: string): Promise<ArchivePackage> {
  const draft = await collectGardenPackage(gardenId);
  if (!draft) throw new Error('山场不存在或已被移走');
  return archiveDraft(draft);
}

/** 移走批次：批次本体 + 其全部工序记录整包入回收区（山场保留，仅随包存引用快照） */
export async function archiveBatch(batchId: string): Promise<ArchivePackage> {
  const draft = await collectBatchPackage(batchId);
  if (!draft) throw new Error('批次不存在或已被移走');
  return archiveDraft(draft);
}

/** 彻底删除归档包（回收区清理，不可恢复） */
export async function removeArchive(archiveId: string): Promise<void> {
  await db.archives.delete(archiveId);
}

/** 清空回收区（清理全部归档包） */
export async function clearArchives(): Promise<void> {
  await db.archives.clear();
}

/* ------------------------------- 恢复 ------------------------------- */

/** 归档包各表的行（按写回顺序：先山场后批次再工序） */
function packageRows(pkg: ArchivePackage): { table: ArchiveTableKey; rows: Array<{ id: string }> }[] {
  return [
    { table: 'garden', rows: pkg.garden ? [pkg.garden] : [] },
    { table: 'batches', rows: pkg.batches },
    { table: 'turns', rows: pkg.turns },
    { table: 'fixes', rows: pkg.fixes },
    { table: 'roasts', rows: pkg.roasts },
    { table: 'reviews', rows: pkg.reviews },
  ];
}

/**
 * 恢复预检：找出与正式表同编号（同 id）冲突的对象，并统计可直接写回的数量。
 * 不写任何数据，供页面列出新旧工艺供人取舍。
 */
export async function planRestore(archiveId: string): Promise<RestorePlan> {
  const pkg = await db.archives.get(archiveId);
  if (!pkg) throw new Error('归档包不存在，可能已被清理');
  const conflicts: RestorePlan['conflicts'] = [];
  const cleanCounts = { garden: 0, batches: 0, turns: 0, fixes: 0, roasts: 0, reviews: 0 } as Record<ArchiveTableKey, number>;

  for (const section of packageRows(pkg)) {
    if (section.rows.length === 0) continue;
    const liveTable = db.table(section.table === 'garden' ? 'gardens' : section.table);
    const ids = section.rows.map((row) => row.id);
    const existingRows = await liveTable.where('id').anyOf(ids).toArray();
    const existingMap = new Map(existingRows.map((row) => [row.id as string, row]));
    section.rows.forEach((row) => {
      const existing = existingMap.get(row.id);
      if (existing) {
        conflicts.push({ table: section.table, id: row.id, archived: row, existing });
      } else {
        cleanCounts[section.table] += 1;
      }
    });
  }

  return { packageId: pkg.id, conflicts, cleanCounts, hasConflicts: conflicts.length > 0 };
}

/**
 * 恢复归档包：整包写回正式表，成功后从回收区移除。
 * - 冲突对象默认保留现有记录（不覆盖）；choices 里显式选 'archived' 才用归档旧记录覆盖
 * - 全部写回与回收区删除在同一个事务：中途失败则回滚到操作前，
 *   正式数据保持原状、归档包仍留在回收区，两边都能继续处理
 */
export async function restoreArchive(archiveId: string, choices: RestoreChoices = {}): Promise<RestorePlan> {
  const plan = await planRestore(archiveId);
  const pkg = (await db.archives.get(archiveId)) as ArchivePackage;

  await db.transaction('rw', ALL_TABLES, async () => {
    for (const section of packageRows(pkg)) {
      const liveTable = db.table(section.table === 'garden' ? 'gardens' : section.table);
      const putRows: object[] = [];
      for (const row of section.rows) {
        const key = conflictKey(section.table, row.id);
        const isConflict = plan.conflicts.some((item) => conflictKey(item.table, item.id) === key);
        if (isConflict && choices[key] !== 'archived') continue; // 缺省与 'existing'：保留现有，不覆盖
        putRows.push(row);
      }
      if (putRows.length > 0) await liveTable.bulkPut(putRows);
    }
    // 全部写回成功后才把归档包移出回收区
    await db.archives.delete(archiveId);
  });

  return plan;
}

/* ---------------------------- 整库导入导出 ---------------------------- */

/** 整库快照（导出 / 导入 JSON 的结构） */
export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  gardens: Garden[];
  batches: Batch[];
  turns: Turn[];
  fixes: Fix[];
  roasts: Roast[];
  reviews: Review[];
  /** 回收区归档（v3 起导出；旧版存档无此字段，导入时按空处理） */
  archives: ArchivePackage[];
}

/** 导出整库快照（含回收区） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [gardens, batches, turns, fixes, roasts, reviews, archives] = await Promise.all([
    db.gardens.toArray(),
    db.batches.toArray(),
    db.turns.toArray(),
    db.fixes.toArray(),
    db.roasts.toArray(),
    db.reviews.toArray(),
    db.archives.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    gardens,
    batches,
    turns,
    fixes,
    roasts,
    reviews,
    archives,
  };
}

/** 用快照覆盖整库（导入存档，含回收区归档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.gardens.clear(),
      db.batches.clear(),
      db.turns.clear(),
      db.fixes.clear(),
      db.roasts.clear(),
      db.reviews.clear(),
      db.archives.clear(),
    ]);
    await db.gardens.bulkPut(snapshot.gardens);
    await db.batches.bulkPut(snapshot.batches);
    await db.turns.bulkPut(snapshot.turns);
    await db.fixes.bulkPut(snapshot.fixes);
    await db.roasts.bulkPut(snapshot.roasts);
    await db.reviews.bulkPut(snapshot.reviews);
    if (Array.isArray(snapshot.archives)) await db.archives.bulkPut(snapshot.archives);
  });
}

/** 清空全部表（含回收区，不重新播种） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.gardens.clear(),
      db.batches.clear(),
      db.turns.clear(),
      db.fixes.clear(),
      db.roasts.clear(),
      db.reviews.clear(),
      db.archives.clear(),
    ]);
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

/** 各表行数概览（页脚与统计徽标使用） */
export async function countAll(): Promise<Record<string, number>> {
  const [gardens, batches, turns, fixes, roasts, reviews, archives, archiveDetails] = await Promise.all([
    db.gardens.count(),
    db.batches.count(),
    db.turns.count(),
    db.fixes.count(),
    db.roasts.count(),
    db.reviews.count(),
    db.archives.count(),
    countArchiveDetails(),
  ]);
  return { gardens, batches, turns, fixes, roasts, reviews, archives, archiveDetails };
}
