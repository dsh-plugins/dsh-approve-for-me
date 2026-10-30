import { defineConfig, type ConfigField } from '@dsh-plugin/dsh-loader/config';
import type { ApproveForMeConfig } from './index.js';
export function createConfigTemplate(base: ApproveForMeConfig) {
  const text = (key: string, label: string): ConfigField => ({ type: 'text', key, label, default: (base as any)[key] ?? '' });
  const number = (key: string, label: string, min: number): ConfigField => ({ type: 'number', key, label, min, default: (base as any)[key] ?? min });
  const choice = (key: string, label: string, values: string[]): ConfigField => ({ type: 'select', key, label, default: (base as any)[key] ?? values[0], options: values.map(value => ({ label: value, value })) });
  const sandbox = ['read-only', 'workspace-write', 'danger-full-access'];
  return defineConfig({ id: 'dsh-approve-for-me', packageName: '@dsh-plugin/dsh-approve-for-me', title: '替我同意', fields: [
    { type: 'group', label: '审查策略', fields: [
      choice('mode', '审查模式', ['off','auto','full-auto','never','review']),
      { type: 'array', key: 'approve', label: '允许规则', default: base.approve ?? [], item: { type: 'text', label: '正则表达式' } },
      { type: 'array', key: 'deny', label: '拒绝规则', default: base.deny ?? [], item: { type: 'text', label: '正则表达式' } },
      choice('grantMode', '授权范围', sandbox),
    ] },
    { type: 'group', label: '权限预设', fields: [
      text('presetName', '预设 ID'), choice('presetSandbox', '预设沙箱', sandbox), choice('presetApproval', '预设审批', ['ask','never']),
      text('strictPresetName', '严格预设 ID'), choice('strictPresetSandbox', '严格沙箱', sandbox), choice('strictPresetApproval', '严格审批', ['ask','never']),
    ] },
    { type: 'group', label: '审查模型', fields: [
      { ...text('reviewProvider', '提供方 ID'), description: '留空沿用会话提供方。' },
      { ...text('reviewModel', '模型 ID'), description: '留空沿用会话模型。' },
      { ...text('reviewPolicy', '附加策略'), type: 'textarea' },
      number('reviewTimeoutMs', '超时（毫秒）', 1), number('reviewMaxAttempts', '最大尝试次数', 1),
      choice('reviewFallback', '失败处理', ['deny','ask']), number('reviewCircuitMaxConsecutive', '连续拒绝上限', 0), number('reviewCircuitMaxRecent', '近期拒绝上限', 0),
      { type: 'boolean', key: 'reviewNotify', label: '写入审查通知', default: base.reviewNotify ?? false },
    ] },
  ] });
}
