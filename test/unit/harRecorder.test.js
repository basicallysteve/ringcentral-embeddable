function loadRecorder({ fetchImpl } = {}) {
  jest.resetModules();
  global.window = {
    location: { href: 'https://app.example.com/' },
    fetch: fetchImpl,
  };
  global.XMLHttpRequest = function XMLHttpRequest() {};
  global.XMLHttpRequest.prototype.open = jest.fn();
  global.XMLHttpRequest.prototype.send = jest.fn();
  global.XMLHttpRequest.prototype.setRequestHeader = jest.fn();
  return require('../../src/lib/HarRecorder');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('HarRecorder', () => {
  afterEach(() => {
    delete global.window;
    delete global.XMLHttpRequest;
  });

  it('records fetch requests and redacts sensitive data', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ access_token: 'secret', name: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();

    const response = await global.window.fetch(
      'https://api.example.com/path?refresh_token=abc&q=1',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer xyz', 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'pw', user: 'bob' }),
      },
    );
    expect(await response.json()).toEqual({ access_token: 'secret', name: 'ok' });
    await flush();

    const { entries } = recorder.getHar().log;
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.request.method).toBe('POST');
    expect(entry.request.url).not.toContain('abc');
    expect(entry.request.url).toContain('q=1');
    expect(entry.request.headers.find((h) => h.name === 'authorization').value).toBe('[REDACTED]');
    expect(entry.request.postData.text).toContain('[REDACTED]');
    expect(entry.request.postData.text).toContain('bob');
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toContain('[REDACTED]');
    expect(entry.response.content.text).not.toContain('secret');
  });

  it('redacts exact sensitive field names but keeps diagnostic codes', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ errors: [{ errorCode: 'OAU-213' }], countryCode: 'US', refreshToken: 'rt' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();

    await global.window.fetch('https://api.example.com/token?areaCode=650&code=abc', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=authcode&code_verifier=verifier&redirect_uri=x',
    });
    await flush();

    const [entry] = recorder.getHar().log.entries;
    expect(entry.request.url).toContain('areaCode=650');
    expect(entry.request.url).not.toContain('code=abc');
    expect(entry.request.postData.text).toBe(
      'grant_type=authorization_code&code=[REDACTED]&code_verifier=[REDACTED]&redirect_uri=x',
    );
    expect(entry.response.content.text).toContain('"errorCode":"OAU-213"');
    expect(entry.response.content.text).toContain('"countryCode":"US"');
    expect(entry.response.content.text).not.toContain('"rt"');
  });

  it('records failed fetch requests and rethrows', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('boom'); });
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();

    await expect(global.window.fetch('https://api.example.com/x')).rejects.toThrow('boom');
    const { entries } = recorder.getHar().log;
    expect(entries[0].response.status).toBe(0);
    expect(entries[0].response.statusText).toContain('boom');
  });

  it('does not consume a Request input before forwarding it to fetch', async () => {
    const fetchImpl = jest.fn(async (input) => {
      if (input.bodyUsed) {
        throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
      }
      return new Response('{}', { status: 200 });
    });
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();
    const request = new Request('https://api.example.com/token', {
      method: 'POST',
      body: 'grant_type=authorization_code',
    });

    await expect(global.window.fetch(request)).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledWith(request, undefined);
  });

  it('caps entries at 500 and can be cleared', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();
    for (let i = 0; i < 505; i += 1) {
      await global.window.fetch(`https://api.example.com/${i}`);
    }
    await flush();
    expect(recorder.getHar().log.entries).toHaveLength(500);
    recorder.clearHar();
    expect(recorder.getHar().log.entries).toHaveLength(0);
  });

  it('records WebSocket lifecycle and redacts SIP authorization', () => {
    const recorder = loadRecorder({ fetchImpl: jest.fn() });
    const base = { connectionId: 'c1', timestamp: Date.parse('2026-01-01T00:00:00Z') };
    recorder.recordWebSocketEvent({ ...base, type: 'connect', url: 'wss://sip.example.com' });
    recorder.recordWebSocketEvent({ ...base, type: 'open' });
    recorder.recordWebSocketEvent({
      ...base,
      type: 'message',
      direction: 'send',
      data: 'REGISTER sip:x SIP/2.0\r\nAuthorization: Digest response="abc"\r\nCSeq: 1 REGISTER',
    });
    recorder.recordWebSocketEvent({
      ...base,
      type: 'message',
      direction: 'receive',
      data: 'SIP/2.0 200 OK',
    });
    recorder.recordWebSocketEvent({
      ...base, type: 'close', code: 1000, reason: 'bye', timestamp: base.timestamp + 500,
    });

    const { entries } = recorder.getHar().log;
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.request.url).toBe('wss://sip.example.com/');
    expect(entry.response.status).toBe(101);
    expect(entry.time).toBe(500);
    expect(entry.response.statusText).toContain('closed (1000)');
    expect(entry._webSocketMessages.map((m) => m.type)).toEqual(['send', 'receive']);
    expect(entry._webSocketMessages[0].data).toContain('Authorization: [REDACTED]');
    expect(entry._webSocketMessages[0].data).not.toContain('Digest');
    expect(entry._webSocketMessages[0].data).toContain('CSeq: 1 REGISTER');
  });

  it('caps messages kept per WebSocket connection', () => {
    const recorder = loadRecorder({ fetchImpl: jest.fn() });
    const base = { connectionId: 'c1', timestamp: 1 };
    recorder.recordWebSocketEvent({ ...base, type: 'connect', url: 'wss://sip.example.com' });
    for (let i = 0; i < 1005; i += 1) {
      recorder.recordWebSocketEvent({
        ...base, type: 'message', direction: 'receive', data: `OPTIONS ${i}`,
      });
    }
    const messages = recorder.getHar().log.entries[0]._webSocketMessages;
    expect(messages).toHaveLength(1000);
    expect(messages[0].data).toBe('OPTIONS 5');
  });

  it('keeps live WebSocket entries when evicting or clearing', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const recorder = loadRecorder({ fetchImpl });
    recorder.installHarRecorder();
    const base = { connectionId: 'c1', timestamp: 1 };
    recorder.recordWebSocketEvent({ ...base, type: 'connect', url: 'wss://sip.example.com' });
    for (let i = 0; i < 505; i += 1) {
      await global.window.fetch(`https://api.example.com/${i}`);
    }
    await flush();
    let { entries } = recorder.getHar().log;
    expect(entries).toHaveLength(500);
    expect(entries[0].request.url).toBe('wss://sip.example.com/');
    expect(entries[1].request.url).toBe('https://api.example.com/6');

    recorder.recordWebSocketEvent({ ...base, type: 'message', direction: 'send', data: 'x' });
    recorder.clearHar();
    ({ entries } = recorder.getHar().log);
    expect(entries).toHaveLength(1);
    expect(entries[0]._webSocketMessages).toHaveLength(0);
    recorder.recordWebSocketEvent({ ...base, type: 'message', direction: 'send', data: 'y' });
    expect(recorder.getHar().log.entries[0]._webSocketMessages).toHaveLength(1);

    recorder.recordWebSocketEvent({ ...base, type: 'close', code: 1000 });
    recorder.clearHar();
    expect(recorder.getHar().log.entries).toHaveLength(0);
  });

  it('ignores WebSocket events for unknown connections', () => {
    const recorder = loadRecorder({ fetchImpl: jest.fn() });
    recorder.recordWebSocketEvent({ connectionId: 'nope', type: 'message', timestamp: 1, data: 'x' });
    expect(recorder.getHar().log.entries).toHaveLength(0);
  });
});
