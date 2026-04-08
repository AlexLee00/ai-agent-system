const n8nRouteModule = require('./n8n.js') as typeof import('./n8n.js');

export const { n8nWebhookRoute, n8nHealthRoute } = n8nRouteModule;
