'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const telegramSender = require('../../../../packages/core/lib/telegram-sender');
const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');

let dailyCount = 0;
let dailyResetDate = '';
let tableEnsured = false;

function isEnabled(): boolean {
  const raw = String(process.env.HUB_ALARM_ROUNDTABLE_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function checkAndIncrementDailyCount(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyResetDate !== today) {
    dailyCount = 0;
    dailyResetDate = today;
  }
  const limit = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);
  if (dailyCount >= limit) return false;
  dailyCount++;
  return true;
}

async function ensureRoundtableTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS agent.alarm_roundtables (
        id BIGSERIAL PRIMARY KEY,
        incident_key TEXT UNIQUE NOT NULL,
        alarm_id BIGINT,
        status TEXT NOT NULL DEFAULT 'open',
        participants JSONB NOT NULL DEFAULT '[]',
        consensus JSONB,
        auto_dev_doc_path TEXT,
        implementation_log JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);
    tableEnsured = true;
  } catch {
    // table may already exist in different schema — continue
    tableEnsured = true;
  }
}

async function getClusterCount(clusterKey: string, hours = 24): Promise<number> {
  try {
    const row = await pgPool.get('agent', `
      SELECT COUNT(*)::int AS cnt
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND metadata->>'cluster_key' = $2
    `, [hours, clusterKey]);
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

export async function shouldTriggerRoundtable({
  alarmType,
  visibility,
  clusterKey,
}: {
  alarmType: string;
  visibility: string;
  clusterKey?: string;
}): Promise<boolean> {
  if (!isEnabled()) return false;
  if (alarmType === 'critical') return true;
  if (alarmType === 'error' && visibility === 'human_action') return true;
  if (alarmType === 'error' && clusterKey) {
    const threshold = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD || 3) || 3);
    const count = await getClusterCount(clusterKey);
    return count >= threshold;
  }
  return false;
}

async function callParticipant({
  selectorKey,
  systemPrompt,
  userPrompt,
  participantName,
}: {
  selectorKey: string;
  systemPrompt: string;
  userPrompt: string;
  participantName: string;
}): Promise<string | null> {
  try {
    const chain = selectLLMChain(selectorKey);
    const result = await callWithFallback({
      chain,
      systemPrompt,
      userPrompt,
      logMeta: { team: 'hub', bot: `roundtable-${participantName}`, requestType: 'alarm_roundtable', selectorKey },
    });
    return result?.text?.trim() || null;
  } catch {
    return null;
  }
}

function buildIncidentContext({
  team,
  fromBot,
  severity,
  title,
  message,
  alarmType,
  incidentKey,
}: {
  team: string;
  fromBot: string;
  severity: string;
  title: string;
  message: string;
  alarmType: string;
  incidentKey: string;
}): string {
  return [
    `incident_key: ${incidentKey}`,
    `team: ${team}`,
    `from_bot: ${fromBot}`,
    `alarm_type: ${alarmType}`,
    `severity: ${severity}`,
    `title: ${title}`,
    `message: ${message.slice(0, 600)}`,
  ].join('\n');
}

export interface RoundtableConsensus {
  rootCause: string;
  proposedFix: string;
  estimatedComplexity: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
  assignedTo: string;
  successCriteria: string;
  agreementScore: number;
}

export interface RoundtableResult {
  roundtableId: number | null;
  incidentKey: string;
  consensus: RoundtableConsensus | null;
  participants: string[];
  meetingNote: string;
}

export async function runRoundtable({
  alarmId,
  incidentKey,
  team,
  fromBot,
  severity,
  title,
  message,
  alarmType,
  clusterKey,
  autoDevDocPath,
}: {
  alarmId: number | null;
  incidentKey: string;
  team: string;
  fromBot: string;
  severity: string;
  title: string;
  message: string;
  alarmType: string;
  clusterKey?: string;
  autoDevDocPath?: string;
}): Promise<RoundtableResult | null> {
  if (!checkAndIncrementDailyCount()) return null;

  try {
    await ensureRoundtableTable();
  } catch {
    return null;
  }

  // Check if roundtable already exists for this incident
  try {
    const existing = await pgPool.get('agent', `
      SELECT id, status FROM agent.alarm_roundtables WHERE incident_key = $1
    `, [incidentKey]);
    if (existing) return null;
  } catch {
    return null;
  }

  let roundtableId: number | null = null;
  try {
    const row = await pgPool.get('agent', `
      INSERT INTO agent.alarm_roundtables (incident_key, alarm_id, status, participants, auto_dev_doc_path)
      VALUES ($1, $2, 'in_progress', $3, $4)
      ON CONFLICT (incident_key) DO NOTHING
      RETURNING id
    `, [incidentKey, alarmId, JSON.stringify(['jay', 'claude_lead', 'team_commander']), autoDevDocPath || null]);
    roundtableId = row?.id ? Number(row.id) : null;
    if (!roundtableId) return null;
  } catch {
    return null;
  }

  const incidentCtx = buildIncidentContext({ team, fromBot, severity, title, message, alarmType, incidentKey });
  const participants: string[] = [];

  // Jay: priority and cross-team impact assessment
  const jayOutput = await callParticipant({
    selectorKey: 'hub.roundtable.jay',
    systemPrompt: `당신은 Jay(팀 오케스트레이터)입니다. 다음 알람 incident를 검토하고 우선순위와 팀 간 영향을 평가하세요.
응답 형식: {"priority": "low|medium|high", "cross_team_impact": "영향 설명", "urgency_reason": "이유"}`,
    userPrompt: incidentCtx,
    participantName: 'jay',
  });
  if (jayOutput) participants.push('jay');

  // Claude: implementation complexity assessment
  const claudeInput = [incidentCtx, jayOutput ? `\n[Jay 평가]\n${jayOutput}` : ''].join('');
  const claudeOutput = await callParticipant({
    selectorKey: 'hub.roundtable.claude_lead',
    systemPrompt: `당신은 Claude(구현팀장)입니다. 이 incident의 구현 복잡도와 예상 작업량을 평가하세요.
응답 형식: {"complexity": "low|medium|high", "estimated_effort": "예상 시간", "regression_risk": "회귀 위험 설명"}`,
    userPrompt: claudeInput,
    participantName: 'claude_lead',
  });
  if (claudeOutput) participants.push('claude_lead');

  // 팀장: root cause and proposed fix
  const teamInput = [incidentCtx, jayOutput ? `\n[Jay]\n${jayOutput}` : '', claudeOutput ? `\n[Claude]\n${claudeOutput}` : ''].join('');
  const teamOutput = await callParticipant({
    selectorKey: 'hub.roundtable.team_commander',
    systemPrompt: `당신은 ${team}팀 팀장입니다. 이 incident의 근본 원인과 해결 방법을 제안하세요.
응답 형식: {"root_cause": "근본 원인", "proposed_fix": "수정 방법", "immediate_action": "즉시 조치"}`,
    userPrompt: teamInput,
    participantName: 'team_commander',
  });
  if (teamOutput) participants.push('team_commander');

  // Judge: synthesize consensus
  const judgeInput = [
    incidentCtx,
    jayOutput ? `\n[Jay 평가]\n${jayOutput}` : '',
    claudeOutput ? `\n[Claude 평가]\n${claudeOutput}` : '',
    teamOutput ? `\n[팀장 평가]\n${teamOutput}` : '',
  ].join('');

  const judgeOutput = await callParticipant({
    selectorKey: 'hub.roundtable.judge',
    systemPrompt: `당신은 회의 진행자입니다. 3명의 평가를 종합하여 최종 합의를 도출하세요.
JSON으로만 응답하세요:
{
  "root_cause": "근본 원인",
  "proposed_fix": "구현 수정 방법",
  "estimated_complexity": "low|medium|high",
  "risk_level": "low|medium|high",
  "assigned_to": "claude-team",
  "success_criteria": "성공 기준",
  "agreement_score": 0.0-1.0
}`,
    userPrompt: judgeInput,
    participantName: 'judge',
  });

  let consensus: RoundtableConsensus | null = null;
  if (judgeOutput) {
    try {
      const text = judgeOutput.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(text);
      consensus = {
        rootCause: String(parsed.root_cause || '미결정'),
        proposedFix: String(parsed.proposed_fix || '검토 필요'),
        estimatedComplexity: ['low', 'medium', 'high'].includes(parsed.estimated_complexity)
          ? parsed.estimated_complexity
          : 'medium',
        riskLevel: ['low', 'medium', 'high'].includes(parsed.risk_level)
          ? parsed.risk_level
          : 'medium',
        assignedTo: String(parsed.assigned_to || 'claude-team'),
        successCriteria: String(parsed.success_criteria || '오류 재발 없음'),
        agreementScore: Math.max(0, Math.min(1, Number(parsed.agreement_score) || 0.5)),
      };
    } catch {
      consensus = null;
    }
  }

  const finalStatus = consensus ? (consensus.agreementScore >= 0.6 ? 'consensus' : 'open') : 'open';

  // Update DB with consensus
  try {
    await pgPool.run('agent', `
      UPDATE agent.alarm_roundtables
      SET status = $2,
          consensus = $3,
          participants = $4,
          resolved_at = CASE WHEN $2 = 'consensus' THEN NOW() ELSE NULL END
      WHERE id = $1
    `, [roundtableId, finalStatus, JSON.stringify(consensus || {}), JSON.stringify(participants)]);
  } catch {
    // non-fatal
  }

  // Build meeting note
  const meetingNote = [
    `🗣️ [Roundtable] ${incidentKey}`,
    `팀: ${team} | 유형: ${alarmType} | severity: ${severity}`,
    '',
    consensus ? [
      `🔍 근본 원인: ${consensus.rootCause}`,
      `🛠️ 해결 방법: ${consensus.proposedFix}`,
      `📊 복잡도: ${consensus.estimatedComplexity} | 위험: ${consensus.riskLevel}`,
      `✅ 성공 기준: ${consensus.successCriteria}`,
      `👤 담당: ${consensus.assignedTo}`,
      `🤝 합의 점수: ${(consensus.agreementScore * 100).toFixed(0)}%`,
    ].join('\n') : '⚠️ 합의 도출 실패 — 마스터 검토 필요',
    autoDevDocPath ? `📄 문서: ${autoDevDocPath}` : '',
  ].filter(Boolean).join('\n');

  // Send to meeting topic
  try {
    await telegramSender.sendFromHubAlarm('meeting', meetingNote);
  } catch {
    // non-fatal
  }

  return {
    roundtableId,
    incidentKey,
    consensus,
    participants,
    meetingNote,
  };
}

export function getDailyRoundtableCount(): number {
  return dailyCount;
}

module.exports = { runRoundtable, shouldTriggerRoundtable, getDailyRoundtableCount };
