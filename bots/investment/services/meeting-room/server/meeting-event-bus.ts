// @ts-nocheck

const DEFAULT_BUFFER_LIMIT = 500;
const TEXT_SUMMARY_LIMIT = 240;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value = Date.now()) {
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function cleanText(value, max = TEXT_SUMMARY_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function sanitizePayload(value) {
  if (!value || typeof value !== 'object') return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (['content', 'fullText', 'markdown', 'raw', 'prompt'].includes(key)) continue;
    if (raw == null) output[key] = raw;
    else if (typeof raw === 'string') output[key] = cleanText(raw, 180);
    else if (typeof raw === 'number' || typeof raw === 'boolean') output[key] = raw;
    else if (Array.isArray(raw)) output[key] = raw.slice(0, 8).map((item) => (
      typeof item === 'object' ? sanitizePayload(item) : item
    ));
    else output[key] = sanitizePayload(raw);
  }
  return output;
}

function sanitizeScores(value) {
  if (!value || typeof value !== 'object') return null;
  const scores = {};
  for (const key of ['bull', 'bear', 'risk']) {
    const parsed = number(value[key], NaN);
    if (Number.isFinite(parsed)) scores[key] = parsed;
  }
  return Object.keys(scores).length ? scores : null;
}

function trimBuffer(buffer, limit) {
  while (buffer.length > limit) buffer.shift();
}

export function createMeetingEventBus(options = {}) {
  const limit = Math.max(1, number(options.limit, DEFAULT_BUFFER_LIMIT));
  const byMeeting = new Map();
  const meetingSeq = new Map();
  const globalBuffer = [];
  const meetingSubscribers = new Map();
  const globalSubscribers = new Set();
  let globalSeq = 0;

  function nextMeetingSeq(meetingId) {
    const key = String(meetingId);
    const seq = (meetingSeq.get(key) || 0) + 1;
    meetingSeq.set(key, seq);
    return seq;
  }

  function meetingBuffer(meetingId) {
    const key = String(meetingId);
    if (!byMeeting.has(key)) byMeeting.set(key, []);
    return byMeeting.get(key);
  }

  function publicEventFrom(input = {}) {
    const meetingId = String(input.meetingId || '').trim();
    if (!meetingId) throw new Error('meeting_event_missing_meeting_id');
    const seq = number(input.seq, 0) > 0 ? number(input.seq) : nextMeetingSeq(meetingId);
    if (seq > number(meetingSeq.get(meetingId), 0)) meetingSeq.set(meetingId, seq);
    const publicEvent = {
      meetingId,
      seq,
      globalSeq: ++globalSeq,
      type: String(input.type || 'meeting.event'),
      agent: input.agent ? String(input.agent) : null,
      role: input.role ? String(input.role) : null,
      agendaKey: input.agendaKey ? String(input.agendaKey) : null,
      createdAt: iso(input.createdAt || Date.now()),
      summary: cleanText(input.summary || input.fullText || input.content || input.payload?.summary || input.type),
      payload: sanitizePayload(input.payload || {}),
      scores: sanitizeScores(input.scores),
      hasFullText: Boolean(String(input.fullText || input.content || '').trim()),
    };
    return {
      ...publicEvent,
      fullText: String(input.fullText || input.content || '').trim() || null,
      publicEvent,
    };
  }

  function notify(subscribers, record) {
    for (const callback of Array.from(subscribers || [])) {
      try {
        callback(record.publicEvent, record);
      } catch {
        // Subscribers are transport/UI concerns and must not break meeting execution.
      }
    }
  }

  function emit(input = {}) {
    const record = publicEventFrom(input);
    const buffer = meetingBuffer(record.meetingId);
    buffer.push(record);
    trimBuffer(buffer, limit);
    globalBuffer.push(record);
    trimBuffer(globalBuffer, limit);
    notify(meetingSubscribers.get(record.meetingId), record);
    notify(globalSubscribers, record);
    return record.publicEvent;
  }

  function getMeetingEvents(meetingId, afterSeq = 0) {
    const floor = number(afterSeq, 0);
    return (meetingBuffer(meetingId) || [])
      .filter((record) => record.seq > floor)
      .map((record) => record.publicEvent);
  }

  function getGlobalEvents(afterGlobalSeq = 0) {
    const floor = number(afterGlobalSeq, 0);
    return globalBuffer
      .filter((record) => record.globalSeq > floor)
      .map((record) => record.publicEvent);
  }

  function getFullEvent(meetingId, seq) {
    const wanted = number(seq, 0);
    return (meetingBuffer(meetingId) || []).find((record) => record.seq === wanted) || null;
  }

  function subscribeMeeting(meetingId, callback) {
    const key = String(meetingId);
    if (!meetingSubscribers.has(key)) meetingSubscribers.set(key, new Set());
    meetingSubscribers.get(key).add(callback);
    return () => {
      const subscribers = meetingSubscribers.get(key);
      if (!subscribers) return;
      subscribers.delete(callback);
      if (subscribers.size === 0) meetingSubscribers.delete(key);
    };
  }

  function subscribeGlobal(callback) {
    globalSubscribers.add(callback);
    return () => globalSubscribers.delete(callback);
  }

  function stats() {
    return {
      globalSeq,
      globalBuffered: globalBuffer.length,
      meetings: Array.from(byMeeting.entries()).map(([meetingId, buffer]) => ({
        meetingId,
        buffered: buffer.length,
        lastSeq: buffer[buffer.length - 1]?.seq || 0,
      })),
      meetingSubscribers: Array.from(meetingSubscribers.entries()).reduce((acc, [meetingId, set]) => {
        acc[meetingId] = set.size;
        return acc;
      }, {}),
      globalSubscribers: globalSubscribers.size,
    };
  }

  return {
    limit,
    emit,
    getMeetingEvents,
    getGlobalEvents,
    getFullEvent,
    subscribeMeeting,
    subscribeGlobal,
    stats,
  };
}

export default { createMeetingEventBus };
