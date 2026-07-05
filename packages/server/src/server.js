import http from 'node:http';
import fs from 'node:fs';

/**
 * Minimal Recall-compatible HTTP API. Auth mirrors Recall:
 * `Authorization: Token <api key>`.
 */
export function createApiServer({ apiToken, manager }) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if ((req.headers.authorization ?? '') !== `Token ${apiToken}`) {
        return send(401, { detail: 'Invalid token.' });
      }
      const url = new URL(req.url, 'http://x');
      const m = url.pathname.match(/^\/api\/v1\/bot(?:\/([0-9a-f-]{36}))?(?:\/([a-z_]+))?\/?$/);
      if (!m) return send(404, { detail: 'Not found.' });
      const [, id, action] = m;

      if (req.method === 'POST' && !id) {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const record = manager.create(JSON.parse(raw || '{}'));
        return send(201, record);
      }
      if (req.method === 'GET' && !id) return send(200, manager.list());

      const record = id && manager.get(id);
      if (!record) return send(404, { detail: 'Not found.' });

      if (req.method === 'GET' && !action) return send(200, record);
      if (req.method === 'POST' && action === 'leave_call') {
        return send(200, await manager.leave(id));
      }
      if (req.method === 'GET' && ['transcript', 'participant_events', 'meeting_metadata'].includes(action)) {
        const p = manager.artifact(id, action);
        if (!p) return send(404, { detail: 'Artifact not ready.' });
        return send(200, JSON.parse(fs.readFileSync(p, 'utf8')));
      }
      if (req.method === 'GET' && action === 'audio') {
        const p = manager.artifact(id, 'audio_mixed');
        if (!p) return send(404, { detail: 'Artifact not ready.' });
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return fs.createReadStream(p).pipe(res);
      }
      return send(405, { detail: 'Method not allowed.' });
    } catch (err) {
      send(err.statusCode ?? 500, { detail: err.message });
    }
  });
}
