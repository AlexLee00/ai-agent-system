export type MonitorAlertOptions = {
  type?: 'new' | 'completed' | 'cancelled' | 'error' | 'info' | string;
  title?: string;
  customer?: string;
  phone?: string;
  date?: string;
  start?: string;
  time?: string;
  room?: string;
  amount?: number | string;
  status?: string;
  reason?: string;
  action?: string;
  error?: string;
};

export function buildMonitorAlertMessage(options: MonitorAlertOptions): string {
  const {
    title = '',
    customer,
    phone,
    date,
    time,
    room,
    amount,
    status,
    reason,
    action,
    error,
  } = options;

  let message = `${title}\n`;
  message += '━━━━━━━━━━━━━━━\n';
  if (customer) message += `👤 고객: ${customer}\n`;
  if (phone) message += `📞 번호: ${phone}\n`;
  if (date) message += `📅 날짜: ${date}\n`;
  if (time) message += `⏰ 시간: ${time}\n`;
  if (room) message += `🏛️ 룸: ${room}\n`;
  if (amount) message += `💰 금액: ${amount}원\n`;
  if (status) message += `📊 상태: ${status}\n`;
  if (reason) message += `ℹ️ 사유: ${reason}\n`;
  if (error) message += `❌ 오류: ${error}\n`;
  message += '━━━━━━━━━━━━━━━\n';
  if (action) message += `✅ 조치: ${action}\n`;
  return message;
}

export function buildUnresolvedAlertsSummary(actionable: Array<Record<string, any>>, nowMs = Date.now()): string {
  let summary = `⚠️ 스카 재시작 — 미해결 오류 ${actionable.length}건\n\n`;
  for (const alert of actionable) {
    const ageMins = Math.floor((nowMs - new Date(alert.timestamp).getTime()) / 60000);
    const ageText = ageMins >= 60 ? `${Math.floor(ageMins / 60)}시간 전` : `${ageMins}분 전`;
    summary += `• [${ageText}] ${alert.title}\n`;
    if (alert.phone) summary += `  📞 ${alert.phone}`;
    if (alert.date) summary += `  📅 ${alert.date}`;
    if (alert.start_time) summary += `  ⏰ ${alert.start_time}`;
    summary += '\n';
  }
  summary += '\n처리 완료 시 자동으로 해결됨 처리됩니다.';
  return summary;
}
