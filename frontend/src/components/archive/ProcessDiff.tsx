/**
 * 新旧工艺对比（components/archive/ProcessDiff.tsx）
 * 恢复时同编号对象已存在，列出归档（旧）与正式表（新）的关键工艺参数供人取舍。
 * 只做展示，不含数据库读写。
 */
import { Tag } from 'antd';
import type { ArchiveTable } from '../../types/archive';

interface ProcessDiffProps {
  table: ArchiveTable;
  archived: Record<string, unknown>;
  live: Record<string, unknown>;
}

/** 各表需要对比的关键参数：字段 → 中文标签 / 渲染后缀 */
const DIFF_FIELDS: Partial<Record<ArchiveTable, Array<{ key: string; label: string; suffix?: string }>>> = {
  gardens: [
    { key: 'name', label: '山场名' },
    { key: 'altitudeM', label: '海拔', suffix: ' m' },
    { key: 'soil', label: '土壤' },
    { key: 'cultivar', label: '品种' },
    { key: 'aspect', label: '朝向' },
  ],
  batches: [
    { key: 'pickedAt', label: '采摘日' },
    { key: 'freshLeafKg', label: '鲜叶', suffix: ' kg' },
    { key: 'tenderness', label: '嫩度' },
    { key: 'weather', label: '气象' },
    { key: 'state', label: '工序状态' },
  ],
  turns: [
    { key: 'roundNo', label: '轮次' },
    { key: 'shakeMin', label: '摇青', suffix: ' 分钟' },
    { key: 'restMin', label: '静置', suffix: ' 分钟' },
    { key: 'roomTempC', label: '室温', suffix: ' ℃' },
    { key: 'humidityPct', label: '湿度', suffix: ' %' },
    { key: 'waterLossPct', label: '失水率', suffix: ' %' },
  ],
  fixes: [
    { key: 'wokTempC', label: '锅温', suffix: ' ℃' },
    { key: 'fixMin', label: '杀青时长', suffix: ' 分钟' },
    { key: 'rollPressure', label: '揉捻压力' },
    { key: 'rollMin', label: '揉捻时长', suffix: ' 分钟' },
    { key: 'operator', label: '操作人' },
  ],
  roasts: [
    { key: 'passNo', label: '道次' },
    { key: 'tempC', label: '温度', suffix: ' ℃' },
    { key: 'hours', label: '时长', suffix: ' h' },
    { key: 'charcoal', label: '炭种' },
    { key: 'state', label: '焙火状态' },
  ],
  reviews: [
    { key: 'reviewedAt', label: '审评日期' },
    { key: 'aroma', label: '香气' },
    { key: 'liquorColor', label: '汤色' },
    { key: 'taste', label: '滋味' },
    { key: 'leafBase', label: '叶底' },
    { key: 'totalScore', label: '加权总分' },
    { key: 'stale', label: '复评状态' },
  ],
};

const TABLE_TITLE: Record<ArchiveTable, string> = {
  gardens: '山场',
  batches: '茶青批次',
  turns: '做青轮次',
  fixes: '杀青揉捻',
  roasts: '焙火道次',
  reviews: '审评',
};

function formatValue(value: unknown, suffix?: string): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? '待复评' : '有效';
  return `${String(value)}${suffix ?? ''}`;
}

/** 单条参数行：旧值 vs 新值，不同处高亮 */
function DiffRow({
  label,
  archived,
  live,
  suffix,
}: {
  label: string;
  archived: unknown;
  live: unknown;
  suffix?: string;
}) {
  const oldText = formatValue(archived, suffix);
  const newText = formatValue(live, suffix);
  const changed = oldText !== newText;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '88px 1fr 1fr',
        gap: 8,
        padding: '4px 0',
        borderBottom: '1px dashed rgba(0,0,0,0.08)',
        fontSize: 13,
      }}
    >
      <span style={{ color: 'rgba(0,0,0,0.65)' }}>{label}</span>
      <span style={{ color: changed ? '#b8742a' : 'rgba(0,0,0,0.85)' }}>
        {changed ? <Tag color="orange" style={{ marginRight: 4 }}>旧</Tag> : null}
        {oldText}
      </span>
      <span style={{ color: changed ? '#2f5136' : 'rgba(0,0,0,0.85)' }}>
        {changed ? <Tag color="green" style={{ marginRight: 4 }}>新</Tag> : null}
        {newText}
      </span>
    </div>
  );
}

export default function ProcessDiff({ table, archived, live }: ProcessDiffProps) {
  const fields = DIFF_FIELDS[table] ?? [];
  return (
    <div style={{ border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, padding: '8px 12px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '88px 1fr 1fr',
          gap: 8,
          paddingBottom: 6,
          marginBottom: 2,
          borderBottom: '1px solid rgba(0,0,0,0.16)',
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        <span>{TABLE_TITLE[table]}参数</span>
        <span>
          <Tag color="orange">回收区（旧工艺）</Tag>
        </span>
        <span>
          <Tag color="green">正式表（现行工艺）</Tag>
        </span>
      </div>
      {fields.map((field) => (
        <DiffRow
          key={field.key}
          label={field.label}
          archived={archived[field.key]}
          live={live[field.key]}
          suffix={field.suffix}
        />
      ))}
    </div>
  );
}
