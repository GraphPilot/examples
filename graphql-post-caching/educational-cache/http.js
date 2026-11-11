// Small adapters between node:http and the Fetch API.

const MAX_BODY_BYTES = 1024 * 1024; // Refuse request bodies above 1 MiB.

// Hop-by-hop headers describe one connection and must not be forwarded.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host', 'upgrade'];

/** Turns a Fetch-style handler into a node:http request listener. */
export function toNodeListener(handle) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? await readBody(req) : undefined;
      if (body === null) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'Request body too large' }] }));
        return;
      }

      const response = await handle(new Request(url, { method: req.method, headers, body }));

      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader('set-cookie', cookies);
      res.writeHead(response.status);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('Proxy error:', error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'Bad gateway' }] }));
    }
  };
}

/** Returns a function that forwards a Fetch Request to an origin base URL. */
export function createHttpOrigin(baseUrl) {
  return async (request) => {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, baseUrl);
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
