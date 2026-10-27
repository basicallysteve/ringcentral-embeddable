/* In-app HAR recorder: captures fetch/XHR traffic so users can export a HAR file
 * from Settings without opening browser dev tools. */

const MAX_ENTRIES = 500;
const MAX_BODY_SIZE = 200 * 1024;
const MAX_WEBSOCKET_MESSAGES = 1000;
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'];
const SENSITIVE_FIELDS = /(access_token|refresh_token|id_token|client_secret|password|code|assertion)/i;

type Header = { name: string; value: string };

const entries: any[] = [];
const webSocketEntries = new Map<string, any>();
let installed = false;

function redactHeader(name: string, value: string): Header {
  return {
    name,
    value: SENSITIVE_HEADERS.includes(name.toLowerCase()) ? '[REDACTED]' : value,
  };
}

function redactBody(text: string | null | undefined): string {
  if (!text) return '';
  let result = text;
  try {
    const json = JSON.parse(text);
    const scrub = (obj: any) => {
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach((key) => {
          if (SENSITIVE_FIELDS.test(key) && typeof obj[key] === 'string') {
            obj[key] = '[REDACTED]';
          } else {
            scrub(obj[key]);
          }
        });
      }
    };
    scrub(json);
    result = JSON.stringify(json);
  } catch (e) {
    // form-encoded or plain text
    result = text.replace(
      new RegExp(`((?:^|&)(?:${SENSITIVE_FIELDS.source.slice(1, -1)})=)[^&]*`, 'gi'),
      '$1[REDACTED]',
    );
  }
  return result.length > MAX_BODY_SIZE ? `${result.slice(0, MAX_BODY_SIZE)}...[TRUNCATED]` : result;
}

function redactSipMessage(text: string): string {
  const redacted = text.replace(
    /^((?:Proxy-)?Authorization)\s*:\s*.*$/gim,
    '$1: [REDACTED]',
  );
  return redactBody(redacted);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    u.searchParams.forEach((_, key) => {
      if (SENSITIVE_FIELDS.test(key)) u.searchParams.set(key, '[REDACTED]');
    });
    return u.toString();
  } catch (e) {
    return url;
  }
}

function queryString(url: string): { name: string; value: string }[] {
  try {
    return Array.from(new URL(url, window.location.href).searchParams.entries())
      .map(([name, value]) => ({ name, value }));
  } catch (e) {
    return [];
  }
}

function push(entry: any) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    // Evict the oldest entry that is not a live WebSocket, so an open SIP connection keeps being exported
    const active = new Set(webSocketEntries.values());
    const index = entries.findIndex((item) => !active.has(item));
    entries.splice(index === -1 ? 0 : index, 1);
  }
}

function buildEntry({
  startedAt, duration, method, url, reqHeaders, reqBody, status, statusText, resHeaders, resBody, mimeType,
}: {
  startedAt: number;
  duration: number;
  method: string;
  url: string;
  reqHeaders: Header[];
  reqBody: string;
  status: number;
  statusText: string;
  resHeaders: Header[];
  resBody: string;
  mimeType: string;
}) {
  const safeUrl = redactUrl(url);
  return {
    startedDateTime: new Date(startedAt).toISOString(),
    time: duration,
    request: {
      method,
      url: safeUrl,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: reqHeaders,
      queryString: queryString(safeUrl),
      headersSize: -1,
      bodySize: reqBody.length,
      ...(reqBody ? { postData: { mimeType: '', text: reqBody } } : {}),
    },
    response: {
      status,
      statusText,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: resHeaders,
      content: { size: resBody.length, mimeType, text: resBody },
      redirectURL: '',
      headersSize: -1,
      bodySize: resBody.length,
    },
    cache: {},
    timings: { send: 0, wait: duration, receive: 0 },
  };
}

function isTextual(mimeType: string) {
  return !mimeType || /json|text|xml|x-www-form-urlencoded/i.test(mimeType);
}

export function recordWebSocketEvent(event: {
  connectionId: string;
  type: 'connect' | 'open' | 'message' | 'close' | 'error';
  url?: string;
  timestamp: number;
  direction?: 'send' | 'receive';
  data?: string;
  code?: number;
  reason?: string;
}) {
  let entry = webSocketEntries.get(event.connectionId);
  if (!entry && event.type === 'connect') {
    const url = redactUrl(event.url || '');
    entry = {
      ...buildEntry({
        startedAt: event.timestamp,
        duration: 0,
        method: 'GET',
        url,
        reqHeaders: [],
        reqBody: '',
        status: 0,
        statusText: 'Connection pending',
        resHeaders: [],
        resBody: '',
        mimeType: '',
      }),
      _webSocketMessages: [],
    };
    webSocketEntries.set(event.connectionId, entry);
    push(entry);
  }
  if (!entry) return;

  if (event.type === 'open') {
    entry.response.status = 101;
    entry.response.statusText = 'Switching Protocols';
  } else if (event.type === 'message') {
    entry._webSocketMessages.push({
      type: event.direction,
      time: new Date(event.timestamp).toISOString(),
      opcode: 1,
      data: redactSipMessage(event.data || ''),
    });
    if (entry._webSocketMessages.length > MAX_WEBSOCKET_MESSAGES) entry._webSocketMessages.shift();
  } else if (event.type === 'close' || event.type === 'error') {
    entry.time = event.timestamp - Date.parse(entry.startedDateTime);
    entry.timings.wait = entry.time;
    entry.response.statusText = event.type === 'close'
      ? `WebSocket closed (${event.code ?? 1000}): ${event.reason || ''}`.trim()
      : 'WebSocket connection error';
    webSocketEntries.delete(event.connectionId);
  }
}

function patchFetch() {
  const originalFetch = window.fetch;
  if (!originalFetch) return;
  window.fetch = async function recordedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const startedAt = Date.now();
    let request: Request | null = null;
    try {
      const requestInput = typeof Request !== 'undefined' && input instanceof Request
        ? input.clone()
        : input;
      request = new Request(requestInput as any, init);
    } catch (e) {
      // ignore, fall back to the raw call
    }
    let reqBody = '';
    if (request) {
      try {
        reqBody = redactBody(await request.clone().text());
      } catch (e) {
        // body not readable
      }
    }
    const method = request?.method || init?.method || 'GET';
    const url = request?.url || String(input);
    const reqHeaders: Header[] = [];
    request?.headers.forEach((value, name) => reqHeaders.push(redactHeader(name, value)));
    try {
      const response = await originalFetch.call(window, input as any, init);
      const resHeaders: Header[] = [];
      response.headers.forEach((value, name) => resHeaders.push(redactHeader(name, value)));
      const mimeType = response.headers.get('content-type') || '';
      const clone = response.clone();
      (isTextual(mimeType) ? clone.text() : Promise.resolve('[binary content omitted]'))
        .catch(() => '')
        .then((text) => {
          push(buildEntry({
            startedAt,
            duration: Date.now() - startedAt,
            method,
            url,
            reqHeaders,
            reqBody,
            status: response.status,
            statusText: response.statusText,
            resHeaders,
            resBody: redactBody(text),
            mimeType,
          }));
        });
      return response;
    } catch (error) {
      push(buildEntry({
        startedAt,
        duration: Date.now() - startedAt,
        method,
        url,
        reqHeaders,
        reqBody,
        status: 0,
        statusText: `Network error: ${(error as Error)?.message || error}`,
        resHeaders: [],
        resBody: '',
        mimeType: '',
      }));
      throw error;
    }
  };
}

function patchXhr() {
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  proto.open = function open(this: any, method: string, url: string | URL, ...rest: any[]) {
    this.__har = { method, url: String(url), reqHeaders: [] as Header[] };
    return (originalOpen as any).call(this, method, url, ...rest);
  };
  proto.setRequestHeader = function setRequestHeader(this: any, name: string, value: string) {
    this.__har?.reqHeaders.push(redactHeader(name, value));
    return originalSetHeader.call(this, name, value);
  };
  proto.send = function send(this: any, body?: any) {
    const meta = this.__har;
    if (meta) {
      const startedAt = Date.now();
      const reqBody = typeof body === 'string' ? redactBody(body) : '';
      this.addEventListener('loadend', () => {
        const resHeaders: Header[] = [];
        (this.getAllResponseHeaders() || '').trim().split(/\r?\n/).forEach((line: string) => {
          const idx = line.indexOf(':');
          if (idx > 0) resHeaders.push(redactHeader(line.slice(0, idx).trim(), line.slice(idx + 1).trim()));
        });
        const mimeType = this.getResponseHeader('content-type') || '';
        let resBody = '';
        if (isTextual(mimeType) && (this.responseType === '' || this.responseType === 'text')) {
          resBody = redactBody(this.responseText);
        } else if (!isTextual(mimeType)) {
          resBody = '[binary content omitted]';
        }
        push(buildEntry({
          startedAt,
          duration: Date.now() - startedAt,
          method: meta.method,
          url: meta.url,
          reqHeaders: meta.reqHeaders,
          reqBody,
          status: this.status,
          statusText: this.statusText,
          resHeaders,
          resBody,
          mimeType,
        }));
      });
    }
    return originalSend.call(this, body);
  };
}

export function installHarRecorder() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  patchFetch();
  patchXhr();
}

export function getHar() {
  return {
    log: {
      version: '1.2',
      creator: { name: 'RingCentral Embeddable HAR recorder', version: '1.0' },
      pages: [],
      entries: entries.slice(),
    },
  };
}

export function clearHar() {
  entries.length = 0;
  // Live WebSocket entries keep receiving messages, so keep them (emptied) in the export
  webSocketEntries.forEach((entry) => {
    entry._webSocketMessages.length = 0;
    entries.push(entry);
  });
}

export function downloadHar() {
  const blob = new Blob([JSON.stringify(getHar(), null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `ringcentral-embeddable-${new Date().toISOString().replace(/[:.]/g, '-')}.har`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
