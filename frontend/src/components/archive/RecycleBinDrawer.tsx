/**
 * 回收区抽屉（components/archive/RecycleBinDrawer.tsx）
 * - 按归档组展示移走的山场 / 批次，保留原顺序与外键引用
 * - 容量满 300 条明细后拒绝新移入（容量条预警）
 * - 每组支持「恢复」（冲突时弹 RestoreDialog 取舍）与「彻底删除」（清理容量）
 */
import { useEffect, useMemo, useState } from 'react';
import { App, Button, Drawer, Empty, Popconfirm, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, RedoOutlined } from '@ant-design/icons';
import { ARCHIVE_DETAIL_CAP, ARCHIVE_TABLES, ARCHIVE_TABLE_LABEL, type ArchiveRecord } from '../../types/archive';
import { getArchiveGroup } from '../../utils/db';
import { archiveCapacityLeft, useArchiveStore } from '../../stores/archiveStore';
import RestoreDialog from './RestoreDialog';

interface RecycleBinDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 归档 / 恢复 / 清理后通知外部刷新正式表 */
  onDataChanged?: () => void | Promise<void>;
}

export default function RecycleBinDrawer({ open, onClose, onDataChanged }: RecycleBinDrawerProps) {
  const { message } = App.useApp();
  const groups = useArchiveStore((state) => state.groups);
  const detailCount = useArchiveStore((state) => state.detailCount);
  const loading = useArchiveStore((state) => state.loading);
  const loadArchives = useArchiveStore((state) => state.loadArchives);
  const openRestorePlan = useArchiveStore((state) => state.openRestorePlan);
  const purgeGroup = useArchiveStore((state) => state.purgeGroup);
  const purgeAll = useArchiveStore((state) => state.purgeAll);

  const [expandedRows, setExpandedRows] = useState<Record<string, ArchiveRecord[]>>({});

  useEffect(() => {
    if (open) void loadArchives();
  }, [loadArchives, open]);

  const capacityLeft = archiveCapacityLeft(detailCount);
  const capacityPercent = Math.min(100, (detailCount / ARCHIVE_DETAIL_CAP) * 100);

  const handleExpand = async (groupId: string): Promise<void> => {
    if (expandedRows[groupId]) return;
    const rows = await getArchiveGroup(groupId);
    setExpandedRows((prev) => ({ ...prev, [groupId]: rows }));
  };

  const handleRestore = async (groupId: string): Promise<void> => {
    const plan = await openRestorePlan(groupId);
    if (!plan) message.error('恢复预检失败，请重试');
    // 预检通过（含无冲突）后由 RestoreDialog 做二次确认与新旧工艺取舍
  };

  const handlePurge = async (groupId: string): Promise<void> => {
    await purgeGroup(groupId);
    setExpandedRows((prev) => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
    message.success('该归档组已彻底删除，回收区容量已释放');
  };

  const handlePurgeAll = async (): Promise<void> => {
    await purgeAll();
    setExpandedRows({});
    message.success('回收区已清空');
  };

  // RestoreDialog 关闭后（无论恢复与否）刷新正式表，覆盖恢复后数据回归的情况
  const plan = useArchiveStore((state) => state.plan);
  const planWasOpen = useMemo(() => plan !== null, [plan]);
  useEffect(() => {
    if (!planWasOpen && open) {
      void loadArchives();
      void onDataChanged?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planWasOpen]);

  const detailColumns: ColumnsType<ArchiveRecord> = [
    {
      title: '来源表',
      dataIndex: 'table',
      width: 110,
      render: (value: ArchiveRecord['table']) => <Tag>{ARCHIVE_TABLE_LABEL[value]}</Tag>,
    },
    {
      title: '顺序',
      dataIndex: 'seq',
      width: 70,
      render: (value: number) => `#${value}`,
    },
    {
      title: '编号 / 关键标识',
      key: 'ref',
      render: (_: unknown, row) => {
        const p = row.payload;
        const order = p.roundNo ?? p.passNo;
        return (
          <Space size={6} wrap>
            <Typography.Text code style={{ fontSize: 12 }}>
              {String(p.id)}
            </Typography.Text>
            {typeof order === 'number' ? <Tag color="gold">第 {order} {row.table === 'turns' ? '轮' : '道'}</Tag> : null}
            {typeof p.batchId === 'string' ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                批次引用 {p.batchId}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const columns: ColumnsType<(typeof groups)[number]> = [
    {
      title: '归档对象',
      key: 'root',
      render: (_: unknown, row) => (
        <Space direction="vertical" size={2}>
          <Space>
            <Tag color={row.kind === 'garden' ? 'green' : 'gold'}>{row.kind === 'garden' ? '山场' : '批次'}</Tag>
            <Typography.Text strong>{row.rootLabel}</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            归档时间 {row.archivedAt.slice(0, 19).replace('T', ' ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '明细构成（保留原顺序与引用）',
      key: 'counts',
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {ARCHIVE_TABLES.filter((table) => row.counts[table] > 0).map((table) => (
            <Tag key={table}>
              {ARCHIVE_TABLE_LABEL[table]} ×{row.counts[table]}
            </Tag>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {row.detailCount} 条
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => void handleRestore(row.archiveGroupId)}>
            恢复
          </Button>
          <Popconfirm
            title="彻底删除该归档组？"
            description="删除后无法再恢复，仅用于释放回收区容量。"
            okText="彻底删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handlePurge(row.archiveGroupId)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              彻底删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      width={920}
      open={open}
      onClose={onClose}
      title="回收区 · 可恢复归档"
      extra={
        groups.length > 0 ? (
          <Popconfirm
            title="清空全部回收区？"
            description="清空后所有已移走的山场 / 批次都无法再恢复。"
            okText="全部清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handlePurgeAll()}
          >
            <Button danger size="small">
              清空回收区
            </Button>
          </Popconfirm>
        ) : null
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Space style={{ marginBottom: 6 }}>
            <Typography.Text strong>回收区容量</Typography.Text>
            <Typography.Text type={capacityLeft <= 30 ? 'danger' : 'secondary'}>
              {detailCount} / {ARCHIVE_DETAIL_CAP} 条明细{capacityLeft <= 30 ? `（仅剩 ${capacityLeft} 条，满后拒绝新移入）` : `（剩余 ${capacityLeft} 条）`}
            </Typography.Text>
          </Space>
          <Progress
            percent={capacityPercent}
            showInfo={false}
            strokeColor={capacityLeft <= 30 ? '#cf1322' : capacityLeft <= 80 ? '#d48806' : '#53805a'}
          />
        </div>

        {groups.length === 0 && !loading ? (
          <Empty
            description={
              <span>
                回收区为空
                <br />
                在山场台账删除山场或批次时，六个工序表的关联记录会整体移到这里，可随时恢复。
              </span>
            }
          />
        ) : (
          <Table
            rowKey="archiveGroupId"
            size="small"
            loading={loading}
            dataSource={groups}
            columns={columns}
            pagination={false}
            expandable={{
              expandRowByClick: false,
              onExpand: (expanded, row) => {
                if (expanded) void handleExpand(row.archiveGroupId);
              },
              expandedRowRender: (row) => (
                <Table<ArchiveRecord>
                  rowKey="id"
                  size="small"
                  dataSource={expandedRows[row.archiveGroupId] ?? []}
                  columns={detailColumns}
                  pagination={false}
                />
              ),
            }}
          />
        )}
      </Space>

      <RestoreDialog />
    </Drawer>
  );
}
