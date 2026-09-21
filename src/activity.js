// Lightweight in-memory activity bus: tracks bridge requests/tool calls per session
// and broadcasts them over SSE for the web dashboard (live feed + agent sprites).

const MAX_HISTORY = 300;
const history = [];
const sseClients = new Set();
const agents = new Map(); // sessionId -> agent state

let nextId = 1;

function touchAgent(sessionId, event) {
  if (!sessionId) return;
  const prev = agents.get(sessionId) || {
    sessionId,
    status: 'idle',
    model: null,
    lastTool: null,
    lastPreview: '',
    requestCount: 0,
    firstSeenAt: event.ts
  };

  switch (event.type) {
    case 'request_start':
      prev.status = 'working';
      prev.model = event.model || prev.model;
      prev.requestCount += 1;
      break;
    case 'thinking':
    case 'content':
      prev.status = 'working';
      if (event.detail?.preview) prev.lastPreview = event.detail.preview;
      break;
    case 'tool_call':
      prev.status = 'working';
      prev.lastTool = event.detail?.name || prev.lastTool;
      break;
    case 'request_end':
      prev.status = 'idle';
      break;
    case 'request_error':
      prev.status = 'error';
      break;
  }

  prev.lastEventAt = event.ts;
  prev.lastEventType = event.type;
  agents.set(sessionId, prev);
}

export function emitActivity({ sessionId, type, model = null, detail = {} }) {
  const event = {
    id: nextId++,
    ts: new Date().toISOString(),
    sessionId: sessionId || 'default',
    type,
    model,
    detail
  };

  touchAgent(event.sessionId, event);

  history.push(event);
  if (history.length > MAX_HISTORY) history.shift();

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }

  return event;
}

export function getRecentActivity(limit = 100) {
  return history.slice(-limit);
}

export function getAgentsSnapshot() {
  return Array.from(agents.values()).sort((a, b) => new Date(b.lastEventAt) - new Date(a.lastEventAt));
}

export function subscribeActivity(res) {
  sseClients.add(res);
}

export function unsubscribeActivity(res) {
  sseClients.delete(res);
}
