'use strict';

const stateBus = require('../../../bots/reservation/lib/state-bus');

const TEAM_LEADS = ['ska', 'claude-lead', 'luna'];

function _validateTeamLead(id) {
  if (!TEAM_LEADS.includes(id)) {
    throw new Error(`유효하지 않은 팀장 ID: ${id}. 허용값: ${TEAM_LEADS.join(', ')}`);
  }
}

async function sendToTeamLead(from, to, message, context = {}, priority = 'normal') {
  _validateTeamLead(from);
  _validateTeamLead(to);

  if (from === to) {
    throw new Error(`자기 자신에게 메시지 전송 불가: ${from}`);
  }

  const payload = {
    message,
    context: context || {},
    sentAt: new Date().toISOString(),
  };

  const eventId = await stateBus.emitEvent(from, to, 'team_message', payload, priority);
  console.log(`📨 [팀 소통] ${from} → ${to}: "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}" (이벤트 #${eventId})`);
  return eventId;
}

async function teamLeadMeeting(agenda, initiator, data = {}, priority = 'normal') {
  _validateTeamLead(initiator);

  const recipients = TEAM_LEADS.filter(id => id !== initiator);
  const payload = {
    agenda,
    data: data || {},
    initiator,
    sentAt: new Date().toISOString(),
  };

  const eventIds = await Promise.all(
    recipients.map(to => stateBus.emitEvent(initiator, to, 'team_meeting', payload, priority))
  );

  console.log(`🏛️  [팀 회의] ${initiator} → [${recipients.join(', ')}]: "${agenda.slice(0, 60)}${agenda.length > 60 ? '…' : ''}" (이벤트 ${eventIds.join(', ')})`);
  return eventIds;
}

async function requestFromTeamLead(from, to, requestType, description, params = {}) {
  _validateTeamLead(from);
  _validateTeamLead(to);

  const payload = {
    requestType,
    description,
    params: params || {},
    sentAt: new Date().toISOString(),
  };

  const eventId = await stateBus.emitEvent(from, to, 'team_request', payload, 'high');
  console.log(`🤝 [팀 요청] ${from} → ${to} [${requestType}]: "${description.slice(0, 60)}${description.length > 60 ? '…' : ''}" (이벤트 #${eventId})`);
  return eventId;
}

async function getPendingMessages(to, limit = 20) {
  _validateTeamLead(to);

  const events = await stateBus.getUnprocessedEvents(to, limit * 2);
  const TEAM_EVENT_TYPES = ['team_message', 'team_meeting', 'team_request'];

  return events
    .filter(e => TEAM_EVENT_TYPES.includes(e.event_type))
    .slice(0, limit)
    .map(e => {
      let parsed = {};
      try { parsed = JSON.parse(e.payload || '{}'); } catch {}
      return {
        id: e.id,
        from: e.from_agent,
        to: e.to_agent,
        eventType: e.event_type,
        priority: e.priority,
        createdAt: e.created_at,
        message: parsed.message || null,
        context: parsed.context || {},
        agenda: parsed.agenda || null,
        data: parsed.data || {},
        initiator: parsed.initiator || null,
        requestType: parsed.requestType || null,
        description: parsed.description || null,
        params: parsed.params || {},
        sentAt: parsed.sentAt || e.created_at,
      };
    });
}

async function ackTeamMessage(eventId) {
  await stateBus.markEventProcessed(eventId);
}

async function getTeamStatus() {
  const all = await stateBus.getAllAgentStates();
  return all
    .filter(s => TEAM_LEADS.includes(s.agent))
    .map(s => ({
      agent: s.agent,
      status: s.status,
      currentTask: s.current_task,
      lastSuccessAt: s.last_success_at,
      lastError: s.last_error,
      updatedAt: s.updated_at,
    }));
}

module.exports = {
  TEAM_LEADS,
  sendToTeamLead,
  teamLeadMeeting,
  requestFromTeamLead,
  getPendingMessages,
  ackTeamMessage,
  getTeamStatus,
};
