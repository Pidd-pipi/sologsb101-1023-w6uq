/**
 * IndexedDB 持久化层（Dexie 封装）· 库名 gbtearock
 * - 结构版本号 version(1) 初版 + version(2) 索引补齐与历史数据迁移 + version(3) 可恢复归档与审评复评
 * - 山场 / 茶青批次 / 做青轮次 / 杀青揉捻 / 焙火 / 审评 六张正式分表 + archives 回收区表
 * - 山场 / 批次移走时六表关联记录整体归档（保留原顺序与引用），可恢复；回收区 300 条明细封顶
 * - 做青 / 杀青 / 焙火参数一变，相关审评与拼配候选失效待复评
 * - 首屏自动播种互相引用的演示数据（山场 → 批次 → 轮次/杀青/焙火/审评 三层贯通）
 * - 纯前端应用：不依赖任何后端、数据库服务或外部接口
 */
import Dexie, { type Table } from 'dexie';
import { CULTIVAR_OPTIONS, SOIL_OPTIONS, type Garden } from '../types/garden';
import { BATCH_STATES, type Batch } from '../types/batch';
import { TURN_LIMITS, type Turn } from '../types/turn';
import type { Fix } from '../types/fix';
import { ROAST_STATES, type Roast } from '../types/roast';
import type { Review, ReviewStaleReason } from '../types/review';
import {
  ARCHIVE_DETAIL_CAP,
  ARCHIVE_TABLES,
  type ArchiveGroupSummary,
  type ArchiveKind,
  type ArchiveRecord,
  type ArchiveTable,
  type RestoreChoice,
  type RestorePlan,
  type RestoreResult,
} from '../types/archive';
import { clampScore, weightedTotalScore } from './tea';
import { buildProcessFingerprint, markReviewStale } from './process';

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
  archive: 'arch',
} as const;

class TeaRockDatabase extends Dexie {
  gardens!: Table<Garden, string>;
  batches!: Table<Batch, string>;
  turns!: Table<Turn, string>;
  fixes!: Table<Fix, string>;
  roasts!: Table<Roast, string>;
  reviews!: Table<Review, string>;
  archives!: Table<ArchiveRecord, string>;

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

    // v3：可恢复归档 + 审评复评失效
    //     1) 新增 archives 回收区表（按归档组归档、保留顺序与引用、300 条明细封顶）；
    //     2) 审评补齐 stale / staleReason / staleAt / processFingerprint，
    //        旧库历史审评按当时工艺快照回填指纹，视为当前有效；
    //     3) 指纹回填需要同批次做青 / 杀青 / 焙火数据，全部在升级事务内读取。
    this.version(DB_VERSION)
      .stores({
        gardens: 'id, name, cultivar, soil, altitudeM, createdAt, updatedAt',
        batches: 'id, gardenId, pickedAt, state, tenderness, createdAt, updatedAt',
        turns: 'id, batchId, roundNo, [batchId+roundNo], createdAt, updatedAt',
        fixes: 'id, batchId, operator, createdAt, updatedAt',
        roasts: 'id, batchId, passNo, state, nextRoastDate, createdAt, updatedAt',
        reviews: 'id, batchId, reviewedAt, totalScore, stale, createdAt, updatedAt',
        archives: 'id, archiveGroupId, kind, table, archivedAt',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 先把六张正式表读全，供审评历史指纹回填
        const [allTurns, allFixes, allRoasts] = await Promise.all([
          tx.table<Turn, string>('turns').toArray(),
          tx.table<Fix, string>('fixes').toArray(),
          tx.table<Roast, string>('roasts').toArray(),
        ]);
        const turnsByBatch = new Map<string, Turn[]>();
        allTurns.forEach((turn) => {
          turnsByBatch.set(turn.batchId, [...(turnsByBatch.get(turn.batchId) ?? []), turn]);
        });
        const roastsByBatch = new Map<string, Roast[]>();
        allRoasts.forEach((roast) => {
          roastsByBatch.set(roast.batchId, [...(roastsByBatch.get(roast.batchId) ?? []), roast]);
        });
        const fixByBatch = new Map<string, Fix>();
        allFixes.forEach((fix) => fixByBatch.set(fix.batchId, fix));

        await tx
          .table<Review, string>('reviews')
          .toCollection()
          .modify((row) => {
            // 旧库升级：补齐归档 / 复评字段，历史审评按当时工艺快照回填指纹（视为有效）
            if (typeof row.stale !== 'boolean') row.stale = false;
            if (typeof row.staleReason !== 'string') row.staleReason = '';
            if (typeof row.staleAt !== 'string') row.staleAt = '';
            if (typeof row.processFingerprint !== 'string' || !row.processFingerprint) {
              row.processFingerprint = buildProcessFingerprint({
                turns: turnsByBatch.get(row.batchId) ?? [],
                fix: fixByBatch.get(row.batchId),
                roasts: roastsByBatch.get(row.batchId) ?? [],
              });
            }
            row.updatedAt = row.updatedAt || stamp;
          });
      });
  }
}

export const db = new TeaRockDatabase();

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

/* ------------------------------ 打开与播种 ------------------------------ */

/**
 * 打开数据库：首次使用时灌入演示数据，保证每个页面打开都有内容。
 * 判断语句固定为 count() === 0 → seedDatabase()。
 */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.gardens.count()) === 0) {
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

  const reviewSeed: Array<Omit<Review, 'totalScore' | 'stale' | 'staleReason' | 'staleAt' | 'processFingerprint'>> = [
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
  const reviews: Review[] = reviewSeed.map((row) => {
    const fingerprint = buildProcessFingerprint({
      turns: turns.filter((turn) => turn.batchId === row.batchId),
      fix: fixes.find((fix) => fix.batchId === row.batchId),
      roasts: roasts.filter((roast) => roast.batchId === row.batchId),
    });
    return {
      ...row,
      totalScore: weightedTotalScore({
        aroma: row.aroma,
        liquorColor: row.liquorColor,
        taste: row.taste,
        leafBase: row.leafBase,
      }),
      stale: false,
      staleReason: '',
      staleAt: '',
      processFingerprint: fingerprint,
    };
  });

  await db.transaction('rw', [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives], async () => {
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

/**
 * 移走山场（可恢复归档）：把山场及其批次、批次下的轮次 / 杀青 / 焙火 / 审评
 * 整体放入回收区同一归档组，保留原 roundNo / passNo 顺序与外键引用。
 * 回收区明细达到 ARCHIVE_DETAIL_CAP（300）时拒绝移入并抛错，事务整体回滚。
 */
export async function removeGarden(id: string): Promise<void> {
  const garden = await db.gardens.get(id);
  if (!garden) return;
  const stamp = nowIso();
  await db.transaction(
    'rw',
    [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives],
    async () => {
      const batches = await db.batches.where('gardenId').equals(id).toArray();
      const batchIds = batches.map((batch) => batch.id);
      const [turns, fixes, roasts, reviews] = await Promise.all([
        batchIds.length > 0 ? db.turns.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([]),
        batchIds.length > 0 ? db.fixes.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([]),
        batchIds.length > 0 ? db.roasts.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([]),
        batchIds.length > 0 ? db.reviews.where('batchId').anyOf(batchIds).toArray() : Promise.resolve([]),
      ]);

      // 顺序：山场 → 批次（采摘日倒序）→ 各子表按原 roundNo / passNo / 日期排列
      const orderedBatches = [...batches].sort((a, b) => b.pickedAt.localeCompare(a.pickedAt));
      const rowsForBatch = (batchId: string) => ({
        turns: turns.filter((row) => row.batchId === batchId).sort((a, b) => a.roundNo - b.roundNo),
        fix: fixes.filter((row) => row.batchId === batchId),
        roasts: roasts.filter((row) => row.batchId === batchId).sort((a, b) => a.passNo - b.passNo),
        reviews: reviews
          .filter((row) => row.batchId === batchId)
          .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt)),
      });

      const groupId = createId(ID_PREFIX.archive);
      const records: ArchiveRecord[] = [];
      const push = (table: ArchiveTable, payload: unknown, seq: number): void => {
        records.push(buildArchiveRow({ groupId, kind: 'garden', table, payload, seq, rootLabel: garden.name, stamp }));
      };
      push('gardens', garden, 0);
      let seq = 1;
      orderedBatches.forEach((batch) => {
        push('batches', batch, seq++);
        const branch = rowsForBatch(batch.id);
        branch.turns.forEach((row) => push('turns', row, seq++));
        branch.fix.forEach((row) => push('fixes', row, seq++));
        branch.roasts.forEach((row) => push('roasts', row, seq++));
        branch.reviews.forEach((row) => push('reviews', row, seq++));
      });

      await assertArchiveCapacity(records.length);
      await db.archives.bulkAdd(records);
      await Promise.all([
        db.turns.bulkDelete(turns.map((row) => row.id)),
        db.fixes.bulkDelete(fixes.map((row) => row.id)),
        db.roasts.bulkDelete(roasts.map((row) => row.id)),
        db.reviews.bulkDelete(reviews.map((row) => row.id)),
        db.batches.bulkDelete(batchIds),
        db.gardens.delete(id),
      ]);
    },
  );
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

/**
 * 移走批次（可恢复归档）：把批次及其轮次 / 杀青 / 焙火 / 审评
 * 整体放入回收区同一归档组，保留原 roundNo / passNo 顺序与外键引用。
 * 回收区明细达到 ARCHIVE_DETAIL_CAP（300）时拒绝移入并抛错，事务整体回滚。
 */
export async function removeBatch(id: string): Promise<void> {
  const batch = await db.batches.get(id);
  if (!batch) return;
  const garden = await db.gardens.get(batch.gardenId);
  const rootLabel = garden ? `${garden.name} · ${batch.pickedAt} · ${batch.tenderness}` : `${batch.pickedAt} · ${batch.tenderness}`;
  const stamp = nowIso();
  await db.transaction(
    'rw',
    [db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives],
    async () => {
      const [turns, fixes, roasts, reviews] = await Promise.all([
        db.turns.where('batchId').equals(id).toArray(),
        db.fixes.where('batchId').equals(id).toArray(),
        db.roasts.where('batchId').equals(id).toArray(),
        db.reviews.where('batchId').equals(id).toArray(),
      ]);
      const groupId = createId(ID_PREFIX.archive);
      const records: ArchiveRecord[] = [];
      const push = (table: ArchiveTable, payload: unknown, seq: number): void => {
        records.push(buildArchiveRow({ groupId, kind: 'batch', table, payload, seq, rootLabel, stamp }));
      };
      push('batches', batch, 0);
      let seq = 1;
      [...turns]
        .sort((a, b) => a.roundNo - b.roundNo)
        .forEach((row) => push('turns', row, seq++));
      fixes.forEach((row) => push('fixes', row, seq++));
      [...roasts]
        .sort((a, b) => a.passNo - b.passNo)
        .forEach((row) => push('roasts', row, seq++));
      [...reviews]
        .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
        .forEach((row) => push('reviews', row, seq++));

      await assertArchiveCapacity(records.length);
      await db.archives.bulkAdd(records);
      await Promise.all([
        db.turns.bulkDelete(turns.map((row) => row.id)),
        db.fixes.bulkDelete(fixes.map((row) => row.id)),
        db.roasts.bulkDelete(roasts.map((row) => row.id)),
        db.reviews.bulkDelete(reviews.map((row) => row.id)),
        db.batches.delete(id),
      ]);
    },
  );
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

/* ---------------------------- 可恢复归档（回收区） ---------------------------- */

/** 回收区明细条数（六表归档行合计） */
export async function countArchiveDetails(): Promise<number> {
  return db.archives.count();
}

/** 构造一条归档明细 */
function buildArchiveRow(params: {
  groupId: string;
  kind: ArchiveKind;
  table: ArchiveTable;
  payload: unknown;
  seq: number;
  rootLabel: string;
  stamp: string;
}): ArchiveRecord {
  return {
    id: createId(`${ID_PREFIX.archive}-${params.table}`),
    archiveGroupId: params.groupId,
    kind: params.kind,
    rootLabel: params.rootLabel,
    table: params.table,
    payload: params.payload as Record<string, unknown>,
    seq: params.seq,
    archivedAt: params.stamp,
    createdAt: params.stamp,
    updatedAt: params.stamp,
  };
}

/** 容量闸门：现有明细 + 本次明细超过 300 条即拒绝移入 */
async function assertArchiveCapacity(incoming: number): Promise<void> {
  const current = await db.archives.count();
  if (current + incoming > ARCHIVE_DETAIL_CAP) {
    throw new Error(
      `回收区容量 ${ARCHIVE_DETAIL_CAP} 条明细已满（现有 ${current} 条，本次需移入 ${incoming} 条），请先清理回收区再移走`,
    );
  }
}

/** 空计数模板 */
function emptyTableCounts(): Record<ArchiveTable, number> {
  return ARCHIVE_TABLES.reduce((acc, table) => {
    acc[table] = 0;
    return acc;
  }, {} as Record<ArchiveTable, number>);
}

/** 回收区分组列表（按归档时间倒序） */
export async function listArchiveGroups(): Promise<ArchiveGroupSummary[]> {
  const rows = await db.archives.toArray();
  const map = new Map<string, ArchiveGroupSummary>();
  rows.forEach((row) => {
    let group = map.get(row.archiveGroupId);
    if (!group) {
      group = {
        archiveGroupId: row.archiveGroupId,
        kind: row.kind,
        rootLabel: row.rootLabel,
        archivedAt: row.archivedAt,
        counts: emptyTableCounts(),
        detailCount: 0,
      };
      map.set(row.archiveGroupId, group);
    }
    group.counts[row.table] += 1;
    group.detailCount += 1;
    // 组内取最新归档时间与组名（rootLabel 组内一致）
    if (row.archivedAt > group.archivedAt) group.archivedAt = row.archivedAt;
  });
  return [...map.values()].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/** 取一个归档组的全部明细（按组内 seq 升序，即原顺序回放） */
export async function getArchiveGroup(groupId: string): Promise<ArchiveRecord[]> {
  const rows = await db.archives.where('archiveGroupId').equals(groupId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

/** 各归档明细对应的正式表（按表名索引） */
const LIVE_TABLE_OF: Record<ArchiveTable, Table<{ id: string }, string>> = {
  gardens: db.gardens,
  batches: db.batches,
  turns: db.turns,
  fixes: db.fixes,
  roasts: db.roasts,
  reviews: db.reviews,
};

/**
 * 恢复预检：读取归档组，找出正式表中同编号（同主键）已存在的明细。
 * 冲突项默认「保留现网」，由 UI 列出新旧工艺供人取舍后再调 restoreArchiveGroup。
 */
export async function planRestoreArchive(groupId: string): Promise<RestorePlan> {
  const records = await getArchiveGroup(groupId);
  const conflicts = await Promise.all(
    records.map(async (record) => {
      const live = (await LIVE_TABLE_OF[record.table].get(String(record.payload.id))) as
        | Record<string, unknown>
        | undefined;
      return live ? { record, live } : null;
    }),
  );
  return {
    archiveGroupId: groupId,
    records,
    conflicts: conflicts
      .filter((item): item is { record: ArchiveRecord; live: Record<string, unknown> } => item !== null)
      .map(({ record, live }) => ({
        archiveId: record.id,
        table: record.table,
        archived: record.payload,
        live,
        choice: 'keep-live' as RestoreChoice,
      })),
  };
}

/**
 * 执行恢复（单事务）：
 * - 无冲突或取舍为「用归档覆盖」的明细，按组内顺序写回正式表并从回收区移除；
 * - 取舍为「保留现网」的明细不动（继续留在回收区），不覆盖现有记录；
 * - 中途任一步失败，事务回滚到恢复操作前状态，回收区与正式数据都保持可继续处理。
 */
export async function restoreArchiveGroup(
  groupId: string,
  choices: Record<string, RestoreChoice>,
): Promise<RestoreResult> {
  return db.transaction(
    'rw',
    [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives],
    async () => {
      const records = await getArchiveGroup(groupId);
      let restored = 0;
      let conflictKept = 0;
      for (const record of records) {
        const choice = choices[record.id] ?? 'keep-live';
        const exists = (await LIVE_TABLE_OF[record.table].get(String(record.payload.id))) !== undefined;
        if (exists && choice === 'keep-live') {
          conflictKept += 1;
          continue;
        }
        await LIVE_TABLE_OF[record.table].put(record.payload as never);
        await db.archives.delete(record.id);
        restored += 1;
      }
      return { restored, conflictKept };
    },
  );
}

/** 永久删除整个归档组（清理回收区，不可恢复） */
export async function purgeArchiveGroup(groupId: string): Promise<void> {
  await db.archives.where('archiveGroupId').equals(groupId).delete();
}

/** 清空回收区（清理，不可恢复） */
export async function purgeAllArchives(): Promise<void> {
  await db.archives.clear();
}

/* ------------------------ 审评失效联动（工艺参数变更） ------------------------ */

/**
 * 做青 / 杀青 / 焙火参数一变：把相关批次的有效审评标记为待复评。
 * 已失效且原因相同的审评不重复刷新；与参数写入放在同一调用链（各 store 的写事务之后）。
 */
export async function invalidateReviewsForBatches(
  batchIds: string[],
  reason: Exclude<ReviewStaleReason, ''>,
): Promise<number> {
  const ids = [...new Set(batchIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const stamp = nowIso();
  let affected = 0;
  await db.transaction('rw', db.reviews, async () => {
    const reviews = await db.reviews.where('batchId').anyOf(ids).toArray();
    const next = reviews
      .filter((review) => !(review.stale && review.staleReason === reason))
      .map((review) => markReviewStale(review, reason, stamp));
    affected = next.length;
    if (next.length > 0) await db.reviews.bulkPut(next);
  });
  return affected;
}

/** 计算某批次当前工艺指纹（审评复评登记时写入快照） */
export async function fingerprintOfBatch(batchId: string): Promise<string> {
  const [turns, fixes, roasts] = await Promise.all([
    db.turns.where('batchId').equals(batchId).toArray(),
    db.fixes.where('batchId').equals(batchId).toArray(),
    db.roasts.where('batchId').equals(batchId).toArray(),
  ]);
  return buildProcessFingerprint({ turns, fix: fixes[0], roasts });
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
  /** 回收区归档明细（旧版存档缺省时按空回收区处理） */
  archives: ArchiveRecord[];
}

/** 导出整库快照（含回收区，避免导出再导入把可恢复数据丢掉） */
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

/**
 * 用快照覆盖整库（导入存档）。
 * 正式六表被存档覆盖；回收区按存档内容回放（旧版存档没有 archives 字段则清空回收区，
 * 因为旧备份不包含任何可恢复对象）。全部在同一事务内，失败回滚。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives],
    async () => {
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
      if (snapshot.archives.length > 0) await db.archives.bulkPut(snapshot.archives);
    },
  );
}

/** 清空全部正式表与回收区（不重新播种） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.gardens, db.batches, db.turns, db.fixes, db.roasts, db.reviews, db.archives],
    async () => {
      await Promise.all([
        db.gardens.clear(),
        db.batches.clear(),
        db.turns.clear(),
        db.fixes.clear(),
        db.roasts.clear(),
        db.reviews.clear(),
        db.archives.clear(),
      ]);
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

/** 各表行数概览（页脚与统计徽标使用） */
export async function countAll(): Promise<Record<string, number>> {
  const [gardens, batches, turns, fixes, roasts, reviews, archives] = await Promise.all([
    db.gardens.count(),
    db.batches.count(),
    db.turns.count(),
    db.fixes.count(),
    db.roasts.count(),
    db.reviews.count(),
    db.archives.count(),
  ]);
  return { gardens, batches, turns, fixes, roasts, reviews, archives };
}
