'use strict';

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function firstLine(value: unknown, limit = 500): string {
  const text = normalizeText(value).split(/\r?\n/)[0] || '';
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export function resolveAlarmDeliveryTeam({
  alarmType,
  visibility,
  team,
}: {
  alarmType?: string;
  visibility?: string;
  team?: string;
}): string {
  const normalizedVisibility = normalizeText(visibility).toLowerCase();
  const normalizedType = normalizeText(alarmType).toLowerCase();
  const normalizedTeam = normalizeText(team, 'general');
  const useClassTopics = ['1', 'true', 'yes', 'y', 'on'].includes(
    String(process.env.HUB_ALARM_USE_CLASS_TOPICS || '').trim().toLowerCase(),
  );

  if (normalizedVisibility === 'emergency') return useClassTopics ? 'ops-emergency' : 'emergency';
  if (normalizedType === 'critical') return useClassTopics ? 'ops-emergency' : 'emergency';
  if (!useClassTopics) return normalizedTeam;
  if (normalizedType === 'work') return 'ops-work';
  if (normalizedType === 'report') return 'ops-reports';
  if (normalizedType === 'error') return 'ops-error-resolution';
  return normalizedTeam;
}

export function formatAlarmNotification({
  alarmType,
  team,
  severity,
  title,
  message,
  eventType,
  incidentKey,
}: {
  alarmType: string;
  team: string;
  severity: string;
  title: string;
  message: string;
  eventType: string;
  incidentKey: string;
}): string {
  const type = normalizeText(alarmType, 'work');
  const label = type === 'report' ? '레포트' : type === 'error' ? '오류' : type === 'critical' ? '긴급' : '실무';
  const icon = type === 'report' ? '📊' : type === 'error' ? '🛠️' : type === 'critical' ? '🔴' : '✅';
  return [
    `${icon} [${team}] ${label} 알림`,
    `제목: ${normalizeText(title, `${team} alarm`)}`,
    `상태: ${normalizeText(severity, 'info')} / ${normalizeText(eventType, 'hub_alarm')}`,
    `요약: ${firstLine(message)}`,
    `incident: ${normalizeText(incidentKey, 'n/a')}`,
  ].join('\n');
}

export function formatAutoRepairResultMessage({
  team,
  status,
  incidentKey,
  summary,
  docPath,
  changedFiles = [],
}: {
  team: string;
  status: string;
  incidentKey: string;
  summary?: string;
  docPath?: string;
  changedFiles?: string[];
}): string {
  const normalizedStatus = normalizeText(status, 'resolved');
  const icon = normalizedStatus === 'resolved'
    ? '✅'
    : normalizedStatus === 'partially_resolved'
      ? '🟡'
      : '🚨';
  const lines = [
    `${icon} [${team}] 오류 처리 결과`,
    `상태: ${normalizedStatus}`,
    `incident: ${normalizeText(incidentKey, 'n/a')}`,
    `요약: ${firstLine(summary || '오류 처리 결과가 등록되었습니다.')}`,
  ];
  if (docPath) lines.push(`문서: ${docPath}`);
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    lines.push(`변경: ${changedFiles.slice(0, 5).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  formatAlarmNotification,
  formatAutoRepairResultMessage,
  resolveAlarmDeliveryTeam,
};

