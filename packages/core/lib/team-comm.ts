const stateBus = require('../../../bots/reservation/lib/state-bus') as {
  emitEvent: (from: string, to: string, eventType: string, payload: Record<string, unknown>, priority?: string) => Promise<number>;
  getUnprocessedEvents: (to: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
  markEventProcessed: (eventId: number) => Promise<void>;
  getAllAgentStates: () => Promise<Array<Record<string, unknown>>>;
};

const TEAM_LEADS = ['ska', 'claude-lead', 'luna'] as const;

function validateTeamLead(id: string): void {
  if (!TEAM_LEADS.includes(id as typeof TEAM_LEADS[number])) {
    throw new Error(`유효하지 않은 팀장 ID: ${id}. 허용값: ${TEAM_LEADS.join(', ')}`);
  }
}

async function sendToTeamLead(
  from: string,
  to: string,
  message: string,
  context: Record<string, unknown> = {},
  priority = 'normal',
): Promise<number> {
  validateTeamLead(from);
  validateTeamLead(to);

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

async function teamLeadMeeting(
  agenda: string,
  initiator: string,
  data: Record<string, unknown> = {},
  priority = 'normal',
): Promise<number[]> {
  validateTeamLead(initiator);

  const recipients = TEAM_LEADS.filter((id) => id !== initiator);
  const payload = {
    agenda,
    data: data || {},
    initiator,
    sentAt: new Date().toISOString(),
  };

  const eventIds = await Promise.all(
    recipients.map((to) => stateBus.emitEvent(initiator, to, 'team_meeting', payload, priority)),
  );

  console.log(`🏛️  [팀 회의] ${initiator} → [${recipients.join(', ')}]: "${agenda.slice(0, 60)}${agenda.length > 60 ? '…' : ''}" (이벤트 ${eventIds.join(', ')})`);
  return eventIds;
}

async function requestFromTeamLead(
  from: string,
  to: string,
  requestType: string,
  description: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  validateTeamLead(from);
  validateTeamLead(to);

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

async function getPendingMessages(to: string, limit = 20): Promise<Record<string, unknown>[]> {
  validateTeamLead(to);

  const events = await stateBus.getUnprocessedEvents(to, limit * 2);
  const TEAM_EVENT_TYPES = ['team_message', 'team_meeting', 'team_request'];

  return events
    .filter((event) => TEAM_EVENT_TYPES.includes(String(event.event_type || '')))
    .slice(0, limit)
    .map((event) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(String(event.payload || '{}')); } catch {}
      return {
        id: event.id,
        from: event.from_agent,
        to: event.to_agent,
        eventType: event.event_type,
        priority: event.priority,
        createdAt: event.created_at,
        message: parsed.message || null,
        context: parsed.context || {},
        agenda: parsed.agenda || null,
        data: parsed.data || {},
        initiator: parsed.initiator || null,
        requestType: parsed.requestType || null,
        description: parsed.description || null,
        params: parsed.params || {},
        sentAt: parsed.sentAt || event.created_at,
      };
    });
}

async function ackTeamMessage(eventId: number): Promise<void> {
  await stateBus.markEventProcessed(eventId);
}

async function getTeamStatus(): Promise<Record<string, unknown>[]> {
  const all = await stateBus.getAllAgentStates();
  return all
    .filter((state) => TEAM_LEADS.includes(String(state.agent || '') as typeof TEAM_LEADS[number]))
    .map((state) => ({
      agent: state.agent,
      status: state.status,
      currentTask: state.current_task,
      lastSuccessAt: state.last_success_at,
      lastError: state.last_error,
      updatedAt: state.updated_at,
    }));
}

export = {
  TEAM_LEADS,
  sendToTeamLead,
  teamLeadMeeting,
  requestFromTeamLead,
  getPendingMessages,
  ackTeamMessage,
  getTeamStatus,
};
