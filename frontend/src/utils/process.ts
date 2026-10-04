/**
 * 工艺指纹与审评失效工具（utils/process.ts）
 * 做青 / 杀青 / 焙火参数一变，相关批次的审评分与拼配候选先失效待复评。
 * 本文件只做纯计算（不碰数据库 / React）：
 * - 把批次的做青、杀青、焙火关键参数序列化成稳定的工艺指纹
 * - 审评登记时记录指纹快照；参数写入后重算指纹与快照不同即判定失效
 */
import type { Turn } from '../types/turn';
import type { Fix } from '../types/fix';
import type { Roast } from '../types/roast';
import type { Review, ReviewStaleReason } from '../types/review';
import { roundTo } from './tea';

/** 做青参数段：按 roundNo 升序保留顺序与关键参数 */
export function turnFingerprintSegment(turns: Turn[]): string {
  const ordered = [...turns].sort((a, b) => a.roundNo - b.roundNo);
  return ordered
    .map(
      (turn) =>
        `t${turn.roundNo}:${roundTo(turn.shakeMin, 1)}|${roundTo(turn.restMin, 1)}|${roundTo(
          turn.roomTempC,
          1,
        )}|${roundTo(turn.humidityPct, 1)}|${roundTo(turn.waterLossPct, 2)}`,
    )
    .join(';');
}

/** 杀青揉捻参数段（一批次至多一条，缺失记为 none） */
export function fixFingerprintSegment(fix: Fix | null | undefined): string {
  if (!fix) return 'f:none';
  return `f:${roundTo(fix.wokTempC, 1)}|${roundTo(fix.fixMin, 2)}|${fix.rollPressure}|${roundTo(
    fix.rollMin,
    2,
  )}`;
}

/** 焙火参数段：按 passNo 升序，温度 / 时长 / 炭种均为关键参数（状态与复焙日期不影响茶叶品质评分） */
export function roastFingerprintSegment(roasts: Roast[]): string {
  const ordered = [...roasts].sort((a, b) => a.passNo - b.passNo);
  return ordered
    .map(
      (roast) =>
        `r${roast.passNo}:${roundTo(roast.tempC, 1)}|${roundTo(roast.hours, 2)}|${roast.charcoal}`,
    )
    .join(';');
}

/** 批次工艺指纹：三段拼合，任一关键参数变化都会使指纹不同 */
export function buildProcessFingerprint(params: {
  turns: Turn[];
  fix: Fix | null | undefined;
  roasts: Roast[];
}): string {
  return [
    turnFingerprintSegment(params.turns),
    fixFingerprintSegment(params.fix),
    roastFingerprintSegment(params.roasts),
  ].join('##');
}

/** 审评当前是否有效（缺省字段按有效处理，由 v3 迁移补全） */
export function isReviewValid(review: Review): boolean {
  return review.stale !== true;
}

/** 失效原因兜底为可读文案 */
export function staleReasonText(review: Pick<Review, 'stale' | 'staleReason'>): string {
  if (!review.stale) return '';
  return review.staleReason || '工艺参数已变';
}

/** 给一条审评打上失效标记（已是同样原因则不重复刷时间） */
export function markReviewStale(
  review: Review,
  reason: Exclude<ReviewStaleReason, ''>,
  stamp: string,
): Review {
  if (review.stale && review.staleReason === reason) return review;
  return { ...review, stale: true, staleReason: reason, staleAt: stamp, updatedAt: stamp };
}

/** 复评通过：清除失效标记并记录最新工艺指纹（重新登记 / 编辑审评时调用） */
export function markReviewFresh(review: Review, fingerprint: string, stamp: string): Review {
  return {
    ...review,
    stale: false,
    staleReason: '',
    staleAt: '',
    processFingerprint: fingerprint,
    updatedAt: stamp,
  };
}
