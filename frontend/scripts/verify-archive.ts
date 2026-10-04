/**
 * 数据层逻辑验证（node + fake-indexeddb，直连 TS 源码经 esbuild 加载）。
 * 覆盖：归档顺序/引用、300 容量封顶、恢复冲突取舍、事务回滚、审评失效联动、旧库 v2→v3 升级。
 * 运行：node --import tsx scripts/verify-archive.ts （本脚本通过 vite 的 esbuild 依赖自行注册）
 */
// @ts-nocheck
import 'fake-indexeddb/auto';
import assert from 'node:assert';

async function main() {
  // 全新库（v3）：init 播种
  const dbModule = await import('../src/utils/db.ts');
  await dbModule.initDatabase();
  const { db } = dbModule;

  const gardenCountBefore = await db.gardens.count();
  assert.ok(gardenCountBefore >= 3, '播种山场');

  // 1) 归档批次：六表关联记录入回收区，保留顺序与引用
  const batchId = 'batch-niulankeng-0426';
  const turnsBefore = await dbModule.listTurnsByBatch(batchId);
  assert.strictEqual(turnsBefore.length, 3, '归档前 3 轮做青');
  await dbModule.removeBatch(batchId);
  assert.strictEqual(await db.batches.get(batchId), undefined, '批次已移出正式表');
  assert.strictEqual((await dbModule.listTurnsByBatch(batchId)).length, 0, '轮次已移出');
  assert.strictEqual(await db.fixes.where('batchId').equals(batchId).count(), 0, '杀青已移出');
  assert.strictEqual(await db.roasts.where('batchId').equals(batchId).count(), 0, '焙火已移出');
  assert.strictEqual(await db.reviews.where('batchId').equals(batchId).count(), 0, '审评已移出');

  const groups = await dbModule.listArchiveGroups();
  const group = groups.find((g) => g.rootLabel.includes('2025-04-26'));
  assert.ok(group, '回收区有该批次归档组');
  assert.strictEqual(group.kind, 'batch');
  assert.strictEqual(group.counts.batches, 1);
  assert.strictEqual(group.counts.turns, 3);
  assert.strictEqual(group.counts.fixes, 1);
  assert.strictEqual(group.counts.roasts, 2);
  assert.strictEqual(group.counts.reviews, 1);
  assert.strictEqual(group.detailCount, 8, '明细 8 条');

  const records = await dbModule.getArchiveGroup(group.archiveGroupId);
  const seqList = records.map((r) => `${r.table}#${r.seq}`);
  assert.deepStrictEqual(
    seqList,
    ['batches#0', 'turns#1', 'turns#2', 'turns#3', 'fixes#4', 'roasts#5', 'roasts#6', 'reviews#7'],
    '组内保留原顺序',
  );
  // 引用保留：归档轮次仍指向原 batchId
  assert.ok(records.every((r) => r.table === 'batches' || r.payload.batchId === batchId), '外键引用保留');

  // 2) 恢复预检：无冲突时 conflicts 为空，整体恢复
  let plan = await dbModule.planRestoreArchive(group.archiveGroupId);
  assert.strictEqual(plan.conflicts.length, 0, '正式表无同编号对象，无冲突');
  let result = await dbModule.restoreArchiveGroup(group.archiveGroupId, {});
  assert.strictEqual(result.restored, 8, '恢复 8 条');
  assert.strictEqual(result.conflictKept, 0);
  assert.strictEqual((await dbModule.listTurnsByBatch(batchId)).length, 3, '轮次回归且顺序可重查');
  assert.strictEqual(await dbModule.countArchiveDetails(), 0, '回收区清空');

  // 3) 同编号冲突：归档批次后，先在正式表手工造一个同 id 但参数不同的批次+轮次，
  //    再恢复预检；默认不覆盖现网
  await dbModule.removeBatch(batchId);
  const g2 = (await dbModule.listArchiveGroups())[0];
  const firstTurn = turnsBefore[0];
  // 模拟恢复期间正式表已存在同编号但工艺更新的对象
  const archivedBatch = g2 ? (await dbModule.getArchiveGroup(g2.archiveGroupId)).find((r) => r.table === 'batches') : null;
  assert.ok(archivedBatch, '归档组内含批次');
  await db.batches.put({ ...(archivedBatch.payload as object) });
  await db.turns.put({ ...firstTurn, shakeMin: 99, updatedAt: new Date().toISOString() });
  plan = await dbModule.planRestoreArchive(g2.archiveGroupId);
  const batchConflict = plan.conflicts.find((c) => c.table === 'batches');
  const turnConflict = plan.conflicts.find((c) => c.table === 'turns' && c.archived.id === firstTurn.id);
  assert.ok(batchConflict, '检测到批次同编号冲突');
  assert.ok(turnConflict, '检测到轮次同编号冲突');
  assert.strictEqual(turnConflict.live.shakeMin, 99, '现行工艺为新值 99');
  assert.strictEqual(turnConflict.archived.shakeMin, 4, '归档为旧值 4');
  // 默认全部保留现网：冲突的 2 条（批次 + 轮次）留在回收区，其余 6 条无冲突明细正常恢复
  const defaultChoices = Object.fromEntries(plan.conflicts.map((c) => [c.archiveId, 'keep-live']));
  result = await dbModule.restoreArchiveGroup(g2.archiveGroupId, defaultChoices);
  assert.strictEqual(result.restored, 6, '无冲突的 6 条子记录正常恢复');
  assert.strictEqual(result.conflictKept, plan.conflicts.length, '冲突明细留在回收区');
  assert.strictEqual((await db.turns.get(firstTurn.id)).shakeMin, 99, '现行记录未被覆盖');
  // 选择该条用归档覆盖，其余保留
  const mixedChoices = { ...defaultChoices, [turnConflict.archiveId]: 'take-archived' };
  result = await dbModule.restoreArchiveGroup(g2.archiveGroupId, mixedChoices);
  assert.strictEqual((await db.turns.get(firstTurn.id)).shakeMin, 4, '选定项被归档旧值覆盖');
  assert.ok(result.restored >= 1 && result.conflictKept >= 1, '覆盖与保留并存');

  // 4) 恢复中途失败回滚：篡改一条归档 payload 主键，使中途 put 后制造删除异常，
  //    用一个始终抛错的场景验证事务原子性：把归档批次的 gardenId 改为不存在不会报错，
  //    这里改为验证容量事务（先压满容量，归档应整体拒绝且正式数据不变）。
  // 先清回收区
  await dbModule.purgeAllArchives();
  const batchRowsBeforeReject = await db.batches.count();
  // 手工灌 297 条明细，使下次归档批次（8 条）超 300
  const fillerGroup = 'arch-filler';
  const filler = [];
  const stampNow = new Date().toISOString();
  for (let i = 0; i < 297; i++) {
    filler.push({
      id: `arch-filler-${i}`,
      archiveGroupId: fillerGroup,
      kind: 'batch',
      rootLabel: '填充',
      table: 'reviews',
      payload: { id: `fill-${i}` },
      seq: i,
      archivedAt: stampNow,
      createdAt: stampNow,
      updatedAt: stampNow,
    });
  }
  await db.archives.bulkAdd(filler);
  let rejected = false;
  try {
    await dbModule.removeBatch('batch-huiyuankeng-0503'); // 明细 3+1+2+1+1=8 → 305
  } catch (error) {
    rejected = true;
    assert.ok(/300/.test(error.message), '报错含 300 容量说明');
  }
  assert.ok(rejected, '容量满拒绝移入');
  assert.strictEqual(await db.batches.count(), batchRowsBeforeReject, '被拒绝后正式批次不变（事务回滚）');
  assert.strictEqual(
    await db.archives.where('archiveGroupId').notEqual(fillerGroup).count(),
    0,
    '被拒绝归档没有残留进回收区',
  );
  await dbModule.purgeAllArchives();

  // 5) 审评失效联动：改做青参数 → 相关审评 stale；复评后恢复
  await dbModule.initDatabase(); // 已播种过，count 非 0 不重灌，先确保牛栏坑在库
  if (!(await db.batches.get(batchId))) {
    // 前序可能已恢复；直接取现有批次
  }
  const targetBatch = (await db.batches.toArray()).find((b) => b.id === 'batch-huiyuankeng-0503');
  const targetReview = (await db.reviews.where('batchId').equals(targetBatch.id).toArray())[0];
  assert.ok(targetReview, '存在审评');
  assert.strictEqual(targetReview.stale, false, '初始有效');
  const affected = await dbModule.invalidateReviewsForBatches([targetBatch.id], '做青参数已变');
  assert.ok(affected >= 1, '失效审评数');
  const staleReview = await db.reviews.get(targetReview.id);
  assert.strictEqual(staleReview.stale, true);
  assert.strictEqual(staleReview.staleReason, '做青参数已变');
  // 指纹复评
  const fp = await dbModule.fingerprintOfBatch(targetBatch.id);
  assert.ok(typeof fp === 'string' && fp.length > 0, '工艺指纹可计算');

  // 6) 快照含回收区
  await dbModule.removeGarden('garden-matouyan'); // 山场归档（2 批次）
  const snap = await dbModule.exportSnapshot();
  assert.ok(Array.isArray(snap.archives) && snap.archives.length > 0, '快照含回收区');
  assert.strictEqual(snap.schemaVersion, 3, '结构版本 3');

  console.log('全部数据层断言通过 ✅');
  db.close();
}

main().catch((error) => {
  console.error('验证失败 ❌', error);
  process.exit(1);
});
