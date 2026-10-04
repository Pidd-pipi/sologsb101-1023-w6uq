/**
 * <ArchiveBin> 回收区：可恢复归档面板
 * - 列出移入的山场 / 批次归档包、六表明细计数与容量占用（上限 300 条明细）
 * - 恢复：先预检同编号（同 id）冲突，冲突时弹出新旧工艺对比，逐项选「用归档 / 保留现有」，
 *   默认不覆盖现有记录；恢复在单事务内完成，中途失败自动回到操作前
 * - 清理：彻底删除单个归档包或清空回收区
 * 被山场与批次台账页（/gardens）消费。
 */
import { useState } from 'react';
import { Alert, App, Badge, Button, Card, Descriptions, Empty, Modal, Popconfirm, Progress, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  InboxOutlined,
  RedoOutlined,
  RollbackOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { ARCHIVE_DETAIL_LIMIT, useArchiveStore } from '../../stores/archiveStore';
import {
  ARCHIVE_KIND_LABEL,
  ARCHIVE_TABLES,
  archiveBreakdown,
  conflictKey,
  type ArchiveConflictItem,
  type ArchivePackage,
  type ArchiveTableKey,
  type RestoreChoice,
  type RestoreChoices,
  type RestorePlan,
} from '../../types/archive';
import { ArchiveQuotaError } from '../../utils/db';

/** 表名 → 中文 */
const TABLE_LABEL: Record<ArchiveTableKey, string> = {
  garden: '山场',
  batches: '批次',
  turns: '做青轮次',
  fixes: '杀青揉捻',
  roasts: '焙火道次',
  reviews: '审评',
};

/** 把记录关键字段渲染成一行新旧工艺对比（按表挑关键参数） */
function describeRow(table: ArchiveTableKey, raw: unknown): string {
  if (!raw || typeof raw !== 'object') return String(raw ?? '—');
  const row = raw as Record<string, unknown>;
  const value = (key: string): string => {
    const v = row[key];
    return v === undefined || v === null || v === '' ? '—' : String(v);
  };
  switch (table) {
    case 'garden':
      return `${value('name')}｜${value('cultivar')}｜${value('soil')}｜海拔 ${value('altitudeM')}m｜${value('aspect')}`;
    case 'batches':
      return `${value('pickedAt')}｜${value('tenderness')}｜${value('freshLeafKg')}kg｜${value('state')}｜${value('weather')}`;
    case 'turns':
      return `第 ${value('roundNo')} 轮｜摇 ${value('shakeMin')}min｜静 ${value('restMin')}min｜${value('roomTempC')}℃｜湿度 ${value('humidityPct')}%｜失水 ${value('waterLossPct')}%`;
    case 'fixes':
      return `锅温 ${value('wokTempC')}℃｜杀青 ${value('fixMin')}min｜揉${value('rollPressure')}压 ${value('rollMin')}min｜${value('operator')}`;
    case 'roasts':
      return `第 ${value('passNo')} 道｜${value('tempC')}℃｜${value('hours')}h｜${value('charcoal')}｜${value('state')}｜复焙 ${value('nextRoastDate') || '无'}`;
    case 'reviews':
      return `${value('reviewedAt')}｜香 ${value('aroma')} / 汤 ${value('liquorColor')} / 味 ${value('taste')} / 底 ${value('leafBase')}｜总分 ${value('totalScore')}${row.invalid ? '｜待复评' : ''}`;
    default:
      return JSON.stringify(raw);
  }
}

export interface ArchiveBinProps {
  /** 恢复 / 清理成功后回调（页面用于刷新正式数据） */
  onChanged?: () => void | Promise<void>;
}

export function ArchiveBin({ onChanged }: ArchiveBinProps) {
  const { message, modal } = App.useApp();
  const packages = useArchiveStore((state) => state.packages);
  const usedDetails = useArchiveStore((state) => state.usedDetails);
  const loading = useArchiveStore((state) => state.loading);
  const initialized = useArchiveStore((state) => state.initialized);
  const refresh = useArchiveStore((state) => state.refresh);
  const inspect = useArchiveStore((state) => state.inspect);
  const restore = useArchiveStore((state) => state.restore);
  const purge = useArchiveStore((state) => state.purge);
  const purgeAll = useArchiveStore((state) => state.purgeAll);

  const [detailPkg, setDetailPkg] = useState<ArchivePackage | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictPkg, setConflictPkg] = useState<ArchivePackage | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [choices, setChoices] = useState<RestoreChoices>({});
  const [restoring, setRestoring] = useState(false);

  const quotaPct = Math.min(100, (usedDetails / ARCHIVE_DETAIL_LIMIT) * 100);
  const quotaFull = usedDetails >= ARCHIVE_DETAIL_LIMIT;

  const breakdownSummary = (pkg: ArchivePackage): string =>
    ARCHIVE_TABLES.map((table) => `${TABLE_LABEL[table]} ${archiveBreakdown(pkg)[table]}`).join(' · ');

  const notifyChanged = async (): Promise<void> => {
    if (onChanged) await onChanged();
  };

  /* ------------------------------ 恢复流程 ------------------------------ */

  const startRestore = async (pkg: ArchivePackage): Promise<void> => {
    try {
      const restorePlan = await inspect(pkg.id);
      if (!restorePlan.hasConflicts) {
        // 无冲突：整包直接写回，单事务保证中途失败回滚
        modal.confirm({
          title: `恢复「${pkg.subjectName}」？`,
          content: `将把 ${pkg.detailCount} 条明细按原顺序与引用写回正式台账，恢复后该归档包自动移出回收区。`,
          okText: '确认恢复',
          cancelText: '取消',
          onOk: () => void(doRestore(pkg.id, {})),
        });
        return;
      }
      // 有同编号对象：不覆盖，列出新旧工艺供人逐项取舍
      setConflictPkg(pkg);
      setPlan(restorePlan);
      setChoices({});
      setConflictOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '恢复预检失败');
    }
  };

  const doRestore = async (archiveId: string, restoreChoices: RestoreChoices): Promise<void> => {
    setRestoring(true);
    try {
      const restorePlan = await restore(archiveId, restoreChoices);
      const usedArchived = Object.values(restoreChoices).filter((choice) => choice === 'archived').length;
      message.success(
        restorePlan.hasConflicts
          ? `恢复完成：${usedArchived} 项用归档旧记录，其余 ${restorePlan.conflicts.length - usedArchived} 项保留现有记录`
          : '已按原顺序与引用恢复到正式台账',
      );
      setConflictOpen(false);
      setConflictPkg(null);
      setPlan(null);
      await notifyChanged();
    } catch (error) {
      // 事务回滚：正式数据与回收区都保持操作前状态，两边都能继续处理
      if (error instanceof ArchiveQuotaError) {
        message.error(error.message);
      } else {
        message.error(`恢复中途失败，已回到操作前状态：${error instanceof Error ? error.message : '未知错误'}`);
      }
      await refresh();
    } finally {
      setRestoring(false);
    }
  };

  const setChoice = (item: ArchiveConflictItem, choice: RestoreChoice): void => {
    setChoices((prev) => ({ ...prev, [conflictKey(item.table, item.id)]: choice }));
  };

  /* ------------------------------ 清理流程 ------------------------------ */

  const handlePurge = async (pkg: ArchivePackage): Promise<void> => {
    try {
      await purge(pkg.id);
      message.success(`已彻底删除归档「${pkg.subjectName}」，回收区腾出 ${pkg.detailCount} 条明细容量`);
      await notifyChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '清理失败');
    }
  };

  const handlePurgeAll = async (): Promise<void> => {
    try {
      await purgeAll();
      message.success('回收区已清空');
      await notifyChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '清空失败');
    }
  };

  const conflictColumns: ColumnsType<ArchiveConflictItem> = [
    {
      title: '对象',
      dataIndex: 'table',
      width: 110,
      render: (table: ArchiveTableKey) => <Tag color="gold">{TABLE_LABEL[table]}</Tag>,
    },
    {
      title: '现有（新）工艺',
      key: 'existing',
      render: (_: unknown, item) => (
        <Typography.Text style={{ fontSize: 12 }}>{describeRow(item.table, item.existing)}</Typography.Text>
      ),
    },
    {
      title: '归档（旧）工艺',
      key: 'archived',
      render: (_: unknown, item) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {describeRow(item.table, item.archived)}
        </Typography.Text>
      ),
    },
    {
      title: '取舍',
      key: 'choice',
      width: 220,
      render: (_: unknown, item) => {
        const current = choices[conflictKey(item.table, item.id)] ?? 'existing';
        return (
          <Space direction="vertical" size={2}>
            <Button
              size="small"
              type={current === 'existing' ? 'primary' : 'default'}
              onClick={() => setChoice(item, 'existing')}
            >
              保留现有
            </Button>
            <Button
              size="small"
              danger={current === 'archived'}
              type={current === 'archived' ? 'primary' : 'default'}
              onClick={() => setChoice(item, 'archived')}
            >
              用归档覆盖
            </Button>
          </Space>
        );
      },
    },
  ];

  const packageColumns: ColumnsType<ArchivePackage> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 96,
      render: (kind: ArchivePackage['kind']) => <Tag color={kind === 'garden' ? 'green' : 'cyan'}>{ARCHIVE_KIND_LABEL[kind]}</Tag>,
    },
    {
      title: '归档对象',
      key: 'subject',
      render: (_: unknown, pkg) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{pkg.subjectName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {breakdownSummary(pkg)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '明细', dataIndex: 'detailCount', width: 70, sorter: (a, b) => a.detailCount - b.detailCount },
    {
      title: '移入时间',
      dataIndex: 'archivedAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }),
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_: unknown, pkg) => (
        <Space size={2} wrap>
          <Tooltip title="按原顺序与引用恢复到正式台账；同编号冲突会先让你逐项取舍">
            <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => void startRestore(pkg)}>
              恢复
            </Button>
          </Tooltip>
          <Button size="small" type="link" icon={<InboxOutlined />} onClick={() => setDetailPkg(pkg)}>
            明细
          </Button>
          <Popconfirm
            title="彻底删除该归档？"
            description="删除后无法再恢复，仅用于回收区容量清理"
            okText="彻底删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handlePurge(pkg)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              清理
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="panel-card"
      title={
        <Space>
          <InboxOutlined />
          <span>回收区（可恢复归档）</span>
          <Badge count={packages.length} showZero color="#8c8c8c" />
        </Space>
      }
      extra={
        <Space wrap>
          <Tooltip title={`回收区按明细行数计容量，上限 ${ARCHIVE_DETAIL_LIMIT} 条；满后拒绝新移入，需先恢复或清理`}>
            <Tag color={quotaFull ? 'red' : quotaPct >= 80 ? 'orange' : 'default'}>
              容量 {usedDetails} / {ARCHIVE_DETAIL_LIMIT} 条明细
            </Tag>
          </Tooltip>
          <Button size="small" icon={<RedoOutlined />} loading={loading} onClick={() => void refresh()}>
            刷新
          </Button>
          {packages.length > 0 ? (
            <Popconfirm
              title="清空整个回收区？"
              description="全部归档将被彻底删除且不可恢复"
              okText="全部清空"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void handlePurgeAll()}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                清空
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      }
    >
      <Progress
        percent={Math.round(quotaPct)}
        size="small"
        status={quotaFull ? 'exception' : quotaPct >= 80 ? 'active' : 'normal'}
        strokeColor={quotaFull ? '#ff4d4f' : undefined}
        style={{ marginBottom: 12 }}
      />
      {quotaFull ? (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          message="回收区容量已满（300 条明细）"
          description="已拒绝新的山场 / 批次移入。请先恢复部分归档到正式台账，或彻底清理不再需要的归档包腾出容量。"
        />
      ) : null}

      {!initialized && loading ? (
        <Empty description="正在读取回收区…" />
      ) : packages.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="回收区为空：移走山场或批次时，六个工序表的关联记录会整包保存在这里，可随时恢复"
        />
      ) : (
        <Table<ArchivePackage>
          rowKey="id"
          size="small"
          dataSource={packages}
          columns={packageColumns}
          pagination={{ pageSize: 5 }}
          loading={loading}
          scroll={{ x: 760 }}
        />
      )}

      {/* ------------------------------ 归档明细抽屉式弹窗 ------------------------------ */}
      <Modal
        open={detailPkg !== null}
        title={detailPkg ? `归档明细 · ${detailPkg.subjectName}` : '归档明细'}
        footer={null}
        width={760}
        onCancel={() => setDetailPkg(null)}
      >
        {detailPkg ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert type="info" showIcon message={detailPkg.summary} />
            <Descriptions
              bordered
              size="small"
              column={2}
              items={ARCHIVE_TABLES.map((table) => ({
                key: table,
                label: TABLE_LABEL[table],
                children: `${archiveBreakdown(detailPkg)[table]} 条`,
              }))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              做青轮次按 roundNo、焙火按 passNo 保持原顺序，批次与山场引用（batchId / gardenId）原样保留，恢复后顺序与关联不变。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>

      {/* ------------------------------ 冲突取舍弹窗 ------------------------------ */}
      <Modal
        open={conflictOpen}
        title={conflictPkg ? `恢复冲突取舍 · ${conflictPkg.subjectName}` : '恢复冲突取舍'}
        width={920}
        okText="按取舍恢复"
        cancelText="取消"
        confirmLoading={restoring}
        onOk={() => conflictPkg && void doRestore(conflictPkg.id, choices)}
        onCancel={() => {
          setConflictOpen(false);
          setConflictPkg(null);
          setPlan(null);
        }}
      >
        {plan ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message={`检测到 ${plan.conflicts.length} 个同编号对象在正式台账已存在`}
              description="为避免覆盖你新录的数据，默认全部「保留现有」。逐项对比新旧工艺后选择：保留现有则跳过该项，用归档覆盖则以旧记录替换。其余无冲突明细将正常恢复。"
            />
            <Table<ArchiveConflictItem>
              rowKey={(item) => conflictKey(item.table, item.id)}
              size="small"
              dataSource={plan.conflicts}
              columns={conflictColumns}
              pagination={plan.conflicts.length > 6 ? { pageSize: 6 } : false}
              scroll={{ x: 760 }}
            />
          </Space>
        ) : null}
      </Modal>
    </Card>
  );
}

export default ArchiveBin;
