/**
 * 恢复冲突取舍弹窗（components/archive/RestoreDialog.tsx）
 * 恢复归档组前预检：同编号对象在正式表已存在时不覆盖，逐条列出新旧工艺，
 * 默认「保留现网」，由人改选「用归档覆盖」后在单事务内回放。
 */
import { Alert, App, Empty, List, Modal, Radio, Space, Tag, Typography } from 'antd';
import ProcessDiff from './ProcessDiff';
import { useArchiveStore } from '../../stores/archiveStore';
import { ARCHIVE_TABLE_LABEL } from '../../types/archive';

export default function RestoreDialog() {
  const { message } = App.useApp();
  const plan = useArchiveStore((state) => state.plan);
  const planLoading = useArchiveStore((state) => state.planLoading);
  const choices = useArchiveStore((state) => state.choices);
  const restoring = useArchiveStore((state) => state.restoring);
  const error = useArchiveStore((state) => state.error);
  const setChoice = useArchiveStore((state) => state.setChoice);
  const closeRestorePlan = useArchiveStore((state) => state.closeRestorePlan);
  const confirmRestore = useArchiveStore((state) => state.confirmRestore);

  const conflicts = plan?.conflicts ?? [];
  const takeArchivedCount = conflicts.filter((item) => choices[item.archiveId] === 'take-archived').length;

  const handleOk = async (): Promise<void> => {
    try {
      const result = await confirmRestore();
      if (result) {
        message.success(
          `已恢复 ${result.restored} 条记录` +
            (result.conflictKept > 0 ? `；${result.conflictKept} 条选择保留现网，仍留在回收区` : ''),
        );
      }
    } catch {
      message.error('恢复中途失败，已回滚到恢复操作前状态，回收区与正式数据都可继续处理');
    }
  };

  return (
    <Modal
      open={plan !== null}
      title="恢复归档 · 同编号对象冲突取舍"
      width={860}
      okText={`确认恢复${takeArchivedCount > 0 ? `（覆盖 ${takeArchivedCount} 条）` : ''}`}
      cancelText="取消"
      confirmLoading={restoring}
      destroyOnClose
      onCancel={closeRestorePlan}
      onOk={() => void handleOk()}
    >
      {planLoading ? (
        <Typography.Text type="secondary">正在比对回收区与正式表…</Typography.Text>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {error ? <Alert type="error" showIcon message={error} /> : null}
          {conflicts.length === 0 ? (
            <Empty
              description={
                <span>
                  该归档组与正式表无同编号冲突，确认后将按原顺序整体恢复
                  <br />
                  （恢复在单事务内完成，中途失败自动回滚）。
                </span>
              }
            />
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                message={`检测到 ${conflicts.length} 条同编号对象在正式表已存在`}
                description="默认保留正式表现网记录（不覆盖）；如确认旧工艺才是要找回的数据，逐条改选「用回收区记录覆盖」，并自行核对下方新旧参数。"
              />
              <List
                dataSource={conflicts}
                renderItem={(conflict) => (
                  <List.Item style={{ display: 'block', padding: '10px 0' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Space wrap>
                        <Tag color="blue">{ARCHIVE_TABLE_LABEL[conflict.table]}</Tag>
                        <Typography.Text strong>编号 {String(conflict.archived.id)}</Typography.Text>
                      </Space>
                      <ProcessDiff table={conflict.table} archived={conflict.archived} live={conflict.live} />
                      <Radio.Group
                        optionType="button"
                        buttonStyle="solid"
                        value={choices[conflict.archiveId] ?? 'keep-live'}
                        onChange={(event) => setChoice(conflict.archiveId, event.target.value)}
                        options={[
                          { value: 'keep-live', label: '保留现网记录（推荐）' },
                          { value: 'take-archived', label: '用回收区记录覆盖' },
                        ]}
                      />
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </Space>
      )}
    </Modal>
  );
}
