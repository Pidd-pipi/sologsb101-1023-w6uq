/**
 * 旧库升级验证：构造 v2 结构的 IndexedDB（含无复评字段的旧审评），
 * 再用当前 db.ts 打开，断言 v3 升级后 archives 表可用、审评补齐复评字段与历史指纹。
 */
// @ts-nocheck
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import assert from 'node:assert';

const DB_NAME = 'gbtearock';
const stamp = new Date().toISOString();

async function buildOldV2() {
  // 直接以 v2 结构建库并写入「旧格式」数据（审评无 stale / fingerprint）
  const oldDb = new Dexie(DB_NAME);
  oldDb.version(2).stores({
    gardens: 'id, name, cultivar, soil, altitudeM, createdAt, updatedAt',
    batches: 'id, gardenId, pickedAt, state, tenderness, createdAt, updatedAt',
    turns: 'id, batchId, roundNo, [batchId+roundNo], createdAt, updatedAt',
    fixes: 'id, batchId, operator, createdAt, updatedAt',
    roasts: 'id, batchId, passNo, state, nextRoastDate, createdAt, updatedAt',
    reviews: 'id, batchId, reviewedAt, totalScore, createdAt, updatedAt',
  });
  await oldDb.transaction('rw', oldDb.tables, async () => {
    await oldDb.table('gardens').put({
      id: 'g1', name: '旧山场', altitudeM: 300, soil: '砾壤', cultivar: '肉桂', aspect: '东',
      createdAt: stamp, updatedAt: stamp,
    });
    await oldDb.table('batches').put({
      id: 'b1', gardenId: 'g1', pickedAt: '2025-04-01', freshLeafKg: 10, tenderness: '一芽三叶',
      weather: '晴', state: '已审评', createdAt: stamp, updatedAt: stamp,
    });
    await oldDb.table('turns').put({
      id: 't1', batchId: 'b1', roundNo: 1, shakeMin: 5, restMin: 40, roomTempC: 23,
      humidityPct: 70, waterLossPct: 5, createdAt: stamp, updatedAt: stamp,
    });
    await oldDb.table('fixes').put({
      id: 'f1', batchId: 'b1', wokTempC: 180, fixMin: 6, rollPressure: '中', rollMin: 10,
      operator: '旧师', createdAt: stamp, updatedAt: stamp,
    });
    await oldDb.table('roasts').put({
      id: 'r1', batchId: 'b1', passNo: 1, tempC: 100, hours: 6, charcoal: '荔枝炭',
      nextRoastDate: '', state: '已足火', createdAt: stamp, updatedAt: stamp,
    });
    await oldDb.table('reviews').put({
      id: 'rv1', batchId: 'b1', reviewedAt: '2025-06-01', aroma: 90, liquorColor: 88, taste: 89,
      leafBase: 86, totalScore: 88.9, blendNote: '', createdAt: stamp, updatedAt: stamp,
    });
  });
  await oldDb.close();
}

async function main() {
  await buildOldV2();

  const dbModule = await import('../src/utils/db.ts');
  await dbModule.db.open(); // 触发 v2 → v3 升级

  assert.strictEqual(dbModule.DB_VERSION, 3, '当前版本 3');
  // archives 表存在且为空
  assert.strictEqual(await dbModule.db.archives.count(), 0, '升级后回收区表可用且为空');
  // 旧审评补齐字段
  const review = await dbModule.db.reviews.get('rv1');
  assert.strictEqual(review.stale, false, '旧审评默认有效');
  assert.strictEqual(review.staleReason, '', '失效原因为空');
  assert.strictEqual(review.staleAt, '', '失效时间为空');
  assert.ok(typeof review.processFingerprint === 'string' && review.processFingerprint.length > 0, '回填历史工艺指纹');
  assert.ok(review.processFingerprint.includes('t1:5|40|23|70|5'), '指纹含旧做青参数');
  assert.ok(review.processFingerprint.includes('f:180|6|中|10'), '指纹含旧杀青参数');
  assert.ok(review.processFingerprint.includes('r1:100|6|荔枝炭'), '指纹含旧焙火参数');

  // 升级后归档能力可用
  await dbModule.removeBatch('b1');
  const groups = await dbModule.listArchiveGroups();
  assert.strictEqual(groups.length, 1, '旧库升级后可归档');
  assert.strictEqual(groups[0].detailCount, 5, '批次 + 轮次 + 杀青 + 焙火 + 审评 = 5 条');

  console.log('旧库 v2 → v3 升级断言通过 ✅');
  dbModule.db.close();
}

main().catch((error) => {
  console.error('升级验证失败 ❌', error);
  process.exit(1);
});
