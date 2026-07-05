import crypto from 'node:crypto';

/**
 * Svix-compatible webhook delivery: svix-id / svix-timestamp / svix-signature
 * headers, HMAC-SHA256 over "{id}.{timestamp}.{payload}", 3 retries with
 * exponential backoff. Fire-and-forget from the caller's perspective.
 */
export class WebhookDispatcher {
  /** @param {{url?: string, secret?: string, fetchImpl?: typeof fetch}} opts */
  constructor(opts = {}) {
    this.url = opts.url;
    this.secret = opts.secret ?? 'whsec_dev';
    this.fetch = opts.fetchImpl ?? fetch;
    this.pending = new Set();
  }

  sign(id, timestamp, payload) {
    const key = this.secret.startsWith('whsec_')
      ? Buffer.from(this.secret.slice(6), 'base64')
      : Buffer.from(this.secret);
    const mac = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
    return `v1,${mac}`;
  }

  send(event, data) {
    if (!this.url) return;
    const id = `msg_${crypto.randomUUID()}`;
    const payload = JSON.stringify({ event, data });
    const task = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        try {
          const res = await this.fetch(this.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'svix-id': id,
              'svix-timestamp': timestamp,
              'svix-signature': this.sign(id, timestamp, payload),
            },
            body: payload,
          });
          if (res.ok) return;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
      console.error(`webhook delivery failed after retries: ${event}`);
    })();
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }

  /** Test helper: wait until all in-flight deliveries settle. */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
