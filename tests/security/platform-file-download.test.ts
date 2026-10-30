import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createPlatformFileDownloadResolver, PlatformFileDownloadError, validateFileOrigins } from '../../src/adapters/mcp/platform-file-download.js';

const file = { download_url: 'https://files.example.test/signed?token=secret', file_id: 'file-1', mime_type: 'image/png' };

test('an optional local observer receives only the rejected exact origin before any network work', () => {
  const observed: string[] = []; let dns = 0; let requests = 0;
  const resolver = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'],
    onRejectedOrigin: origin => { observed.push(origin); } }, {
    async resolveAddresses() { dns++; return []; }, request() { requests++; throw new Error('Unexpected network'); },
  });
  const marker = 'PRIVATE_REFERENCE_MARKER';
  assert.throws(() => resolver({ ...file, download_url: `https://unapproved.example.test/private/${marker}?sig=${marker}`,
    file_id: marker }), (error: Error) => error instanceof PlatformFileDownloadError && error.inputFailure === 'origin_not_allowed');
  assert.deepEqual(observed, ['https://unapproved.example.test']);
  assert.ok(!JSON.stringify(observed).includes(marker));
  assert.throws(() => resolver({ ...file, download_url: `http://unapproved.example.test/${marker}` }));
  resolver(file); // Allowed references do not emit a rejected-origin diagnostic.
  assert.deepEqual(observed, ['https://unapproved.example.test']);
  assert.equal(dns, 0); assert.equal(requests, 0);
});

test('a failing local origin observer never changes refusal or exposes its error', () => {
  const marker = 'PRIVATE_OBSERVER_ERROR'; let called = 0;
  const resolver = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'],
    onRejectedOrigin: () => { called++; throw new Error(marker); } }, {
    async resolveAddresses() { throw new Error('Unexpected DNS'); }, request() { throw new Error('Unexpected request'); },
  });
  assert.throws(() => resolver({ ...file, download_url: 'https://unapproved.example.test/original' }), (error: Error) => {
    assert.ok(error instanceof PlatformFileDownloadError);
    assert.equal(error.inputFailure, 'origin_not_allowed'); assert.equal(error.stage, 'input');
    assert.ok(!JSON.stringify(error).includes(marker)); assert.ok(!error.message.includes(marker));
    assert.ok(!JSON.stringify(error).includes('unapproved.example.test')); return true;
  });
  assert.equal(called, 1);
});

function fixture(addresses: { address: string; family: 4 | 6 }[], status = 200,
  body = Buffer.from('bytes'), emitErrorOnDestroy = false) {
  const requests: { url: URL; options: RequestOptions }[] = [];
  const resolver = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'] }, {
    async resolveAddresses() { return addresses; },
    request(url, options, onResponse) {
      requests.push({ url, options });
      const req = new EventEmitter() as ClientRequest;
      req.end = () => {
        const stream = new PassThrough();
        const response = stream as unknown as IncomingMessage;
        response.statusCode = status;
        process.nextTick(() => { onResponse(response); stream.end(body); });
        return req;
      };
      req.destroy = () => {
        if (emitErrorOnDestroy) req.emit('error', new Error('signed-url-secret'));
        return req;
      };
      return req;
    },
  });
  return { resolver, requests };
}

test('requires explicit origin and rejects unsafe URL forms before DNS', async () => {
  assert.throws(() => createPlatformFileDownloadResolver({ allowedOrigins: [] }), /File transfer unavailable/);
  const { resolver } = fixture([{ address: '93.184.216.34', family: 4 }]);
  for (const download_url of [
    'http://files.example.test/a', 'https://evil.test/a', 'https://127.0.0.1/a',
    'https://user:pass@files.example.test/a', 'https://files.example.test:444/a',
    'https://files.example.test/a#fragment', 'https://files.example.test./a',
    'https://[::1]/a',
  ]) assert.throws(() => resolver({ ...file, download_url }), /File transfer unavailable/);
});

test('operator origins must be exact canonical HTTPS DNS origins', () => {
  assert.deepEqual(validateFileOrigins([]), []);
  assert.deepEqual(validateFileOrigins(['https://files.example.test']), ['https://files.example.test']);
  for (const origin of ['http://files.example.test', 'https://files.example.test/',
    'https://files.example.test:443', 'https://FILES.example.test',
    'https://files.example.test.', 'https://user@files.example.test',
    'https://files.example.test/path', 'https://files.example.test?x=1',
    'https://127.0.0.1', 'https://[::1]', 'https://files.example.test\\@evil.test']) {
    assert.throws(() => validateFileOrigins([origin]), /File transfer unavailable/);
  }
  assert.throws(() => validateFileOrigins(['https://files.example.test', 'https://files.example.test']),
    /File transfer unavailable/);
  assert.throws(() => createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test/'] }),
    /File transfer unavailable/);
});

test('rejects DNS answers with private or reserved address and never sends request', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.1.2', '192.0.2.1', '::1', '::ffff:127.0.0.1']) {
    const { resolver, requests } = fixture([{ address: '93.184.216.34', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 }]);
    await assert.rejects(resolver(file).acquireBytes(1024), /File transfer unavailable/);
    assert.equal(requests.length, 0);
  }
});

test('pins resolved IP while preserving hostname for HTTPS and keeps original bytes', async () => {
  const { resolver, requests } = fixture([{ address: '93.184.216.34', family: 4 }]);
  const transfer = resolver(file);
  assert.equal(transfer.referenceIdentity, createHash('sha256').update('file-1').digest('hex'));
  assert.equal(transfer.mediaType, 'image/png');
  assert.deepEqual(await transfer.acquireBytes(1024), Buffer.from('bytes'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.hostname, 'files.example.test');
  assert.equal(requests[0]?.options.servername, 'files.example.test');
  assert.equal(requests[0]?.options.rejectUnauthorized, true);
  assert.equal(requests[0]?.options.agent, false);
  const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    requests[0]?.options.lookup?.('files.example.test', {}, (error, address, family) =>
      error ? reject(error) : resolve({ address: address as string, family: family as number }));
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('missing platform MIME stays distinct from explicit declarations', () => {
  const { resolver } = fixture([{ address: '93.184.216.34', family: 4 }]);
  assert.equal(resolver({ download_url: file.download_url, file_id: file.file_id }).mediaType, null);
  assert.equal(resolver({ ...file, mime_type: 'application/octet-stream' }).mediaType, 'application/octet-stream');
  for (const mime_type of ['', 'image/png\r\nmalicious', 'invalid']) {
    assert.throws(() => resolver({ ...file, mime_type }), /File transfer unavailable/);
  }
});

test('Node 24 automatic family selection receives a pinned address array', async () => {
  const { resolver, requests } = fixture([{ address: '93.184.216.34', family: 4 }]);
  await resolver(file).acquireBytes(1024);
  const pinned = await new Promise<unknown>((resolve, reject) => {
    requests[0]?.options.lookup?.('files.example.test', { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses));
  });
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
});

test('denies redirects, HTTP errors and oversized streams', async () => {
  for (const status of [302, 404]) {
    const { resolver } = fixture([{ address: '93.184.216.34', family: 4 }], status);
    await assert.rejects(resolver(file).acquireBytes(1024), (error: Error) =>
      error instanceof PlatformFileDownloadError && error.stage === 'http_status' &&
      error.message === 'File transfer unavailable' && !JSON.stringify(error).includes('secret'));
  }
  const { resolver } = fixture([{ address: '93.184.216.34', family: 4 }], 200, Buffer.alloc(6));
  await assert.rejects(resolver(file).acquireBytes(5), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'size' &&
    error.message === 'File transfer unavailable');
  const racing = fixture([{ address: '93.184.216.34', family: 4 }], 200, Buffer.alloc(6), true);
  await assert.rejects(racing.resolver(file).acquireBytes(5), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'size' &&
    !JSON.stringify(error).includes('signed-url-secret'));
});

test('DNS and response timeouts fail without exposing signed URL', async () => {
  const never = new Promise<{ address: string; family: 4 | 6 }[]>(() => {});
  const dnsResolver = createPlatformFileDownloadResolver({
    allowedOrigins: ['https://files.example.test'], timeoutMs: 5,
  }, {
    resolveAddresses: async () => never,
    request() { throw new Error('must not request'); },
  });
  await assert.rejects(dnsResolver(file).acquireBytes(100), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'dns' &&
    error.message === 'File transfer unavailable' && !error.message.includes('secret'));

  const responseResolver = createPlatformFileDownloadResolver({
    allowedOrigins: ['https://files.example.test'], timeoutMs: 5,
  }, {
    async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
    request() {
      const req = new EventEmitter() as ClientRequest;
      req.end = () => req;
      req.destroy = () => req;
      return req;
    },
  });
  await assert.rejects(responseResolver(file).acquireBytes(100), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'timeout' &&
    error.message === 'File transfer unavailable' && !error.message.includes('secret'));
});

test('a transient connection loss retries a fresh pinned GET within one transfer budget', async () => {
  let resolutions = 0;
  let requests = 0;
  const transfer = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
    async resolveAddresses() { resolutions++; return [{ address: '93.184.216.34', family: 4 }]; },
    request(_url, _options, onResponse) {
      requests++;
      const attempt = requests;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => {
        process.nextTick(() => {
          if (attempt === 1) req.emit('error', Object.assign(new Error('signed-url-secret'), { code: 'ECONNRESET' }));
          else {
            const stream = new PassThrough();
            const response = stream as unknown as IncomingMessage;
            response.statusCode = 200;
            onResponse(response);
            stream.end('complete');
          }
        });
        return req;
      };
      req.destroy = () => req;
      return req;
    },
  })(file);
  assert.deepEqual(await transfer.acquireBytes(100), Buffer.from('complete'));
  assert.equal(requests, 2);
  assert.equal(resolutions, 2);
});

test('retries a transient HTTP status, but refuses redirect, authorization and size failures', async () => {
  for (const firstStatus of [408, 429, 503]) {
    let requests = 0;
    const transfer = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
      async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
      request(_url, _options, onResponse) {
        requests++;
        const status = requests === 1 ? firstStatus : 200;
        const req = new EventEmitter() as ClientRequest;
        req.end = () => {
          process.nextTick(() => {
            const stream = new PassThrough();
            const response = stream as unknown as IncomingMessage;
            response.statusCode = status;
            onResponse(response);
            stream.end('valid');
          });
          return req;
        };
        req.destroy = () => req;
        return req;
      },
    })(file);
    assert.deepEqual(await transfer.acquireBytes(100), Buffer.from('valid'));
    assert.equal(requests, 2);
  }
  for (const status of [302, 401, 403]) {
    const { resolver, requests } = fixture([{ address: '93.184.216.34', family: 4 }], status);
    await assert.rejects(resolver(file).acquireBytes(100),
      (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'http_status');
    assert.equal(requests.length, 1);
  }
  const oversized = fixture([{ address: '93.184.216.34', family: 4 }], 200, Buffer.alloc(101));
  await assert.rejects(oversized.resolver(file).acquireBytes(100),
    (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'size');
  assert.equal(oversized.requests.length, 1);
});

test('a broken response retries without mixing bytes from the failed stream', async () => {
  let attempts = 0;
  const transfer = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
    async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
    request(_url, _options, onResponse) {
      attempts++;
      const current = attempts;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => {
        process.nextTick(() => {
          const stream = new PassThrough();
          const response = stream as unknown as IncomingMessage;
          response.statusCode = 200;
          onResponse(response);
          if (current === 1) { stream.write('bad-prefix'); response.emit('aborted'); }
          else stream.end('complete');
        });
        return req;
      };
      req.destroy = () => req;
      return req;
    },
  })(file);
  assert.deepEqual(await transfer.acquireBytes(100), Buffer.from('complete'));
  assert.equal(attempts, 2);
});

test('DNS is checked again on retry and a rebinding to a private address stops immediately', async () => {
  let resolutions = 0;
  let requests = 0;
  const transfer = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
    async resolveAddresses() {
      resolutions++;
      return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    },
    request() {
      requests++;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => { process.nextTick(() => req.emit('error', Object.assign(new Error('secret'), { code: 'ECONNRESET' }))); return req; };
      req.destroy = () => req;
      return req;
    },
  })(file);
  await assert.rejects(transfer.acquireBytes(100),
    (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'address');
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test('retry exhaustion and a shared deadline return safe diagnostics without extra GETs', async () => {
  let requests = 0;
  const exhausted = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
    async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
    request() {
      requests++;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => { process.nextTick(() => req.emit('error', Object.assign(new Error('signed-url-secret'), { code: 'ECONNRESET' }))); return req; };
      req.destroy = () => req;
      return req;
    },
  })(file);
  await assert.rejects(exhausted.acquireBytes(100), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'request' &&
    error.retryExhausted === true && !JSON.stringify(error).includes('secret'));
  assert.equal(requests, 3);

  let deadlineRequests = 0;
  const deadline = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 8 }, {
    async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
    request() {
      deadlineRequests++;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => req;
      req.destroy = () => req;
      return req;
    },
  })(file);
  await assert.rejects(deadline.acquireBytes(100),
    (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'timeout');
  assert.equal(deadlineRequests, 1);
});

test('permanent transport failures do not retry and the trusted attempt limit is bounded', async () => {
  for (const maxAttempts of [0, 4, 1.5]) {
    assert.throws(() => createPlatformFileDownloadResolver({
      allowedOrigins: ['https://files.example.test'], maxAttempts,
    }), /File transfer unavailable/);
  }
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    let requests = 0;
    const transfer = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'] }, {
      async resolveAddresses() { return [{ address: '93.184.216.34', family: 4 }]; },
      request() {
        requests++;
        const req = new EventEmitter() as ClientRequest;
        req.end = () => { process.nextTick(() => req.emit('error', Object.assign(new Error('signed-url-secret'), { code }))); return req; };
        req.destroy = () => req;
        return req;
      },
    })(file);
    await assert.rejects(transfer.acquireBytes(100), (error: Error) =>
      error instanceof PlatformFileDownloadError && error.stage === 'request' &&
      error.retryExhausted === false && !JSON.stringify(error).includes('secret'));
    assert.equal(requests, 1);
  }
});

test('temporary DNS failure can recover, but a permanent name failure cannot trigger a GET', async () => {
  let resolutions = 0;
  let requests = 0;
  const retryable = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'], timeoutMs: 1_000 }, {
    async resolveAddresses() {
      resolutions++;
      if (resolutions === 1) throw Object.assign(new Error('hidden-hostname'), { code: 'EAI_AGAIN' });
      return [{ address: '93.184.216.34', family: 4 }];
    },
    request(_url, _options, onResponse) {
      requests++;
      const req = new EventEmitter() as ClientRequest;
      req.end = () => {
        process.nextTick(() => {
          const stream = new PassThrough();
          const response = stream as unknown as IncomingMessage;
          response.statusCode = 200;
          onResponse(response);
          stream.end('recovered');
        });
        return req;
      };
      req.destroy = () => req;
      return req;
    },
  })(file);
  assert.deepEqual(await retryable.acquireBytes(100), Buffer.from('recovered'));
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);

  let permanentResolutions = 0;
  const permanent = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'] }, {
    async resolveAddresses() {
      permanentResolutions++;
      throw Object.assign(new Error('hidden-hostname'), { code: 'ENOTFOUND' });
    },
    request() { throw new Error('must not request'); },
  })(file);
  await assert.rejects(permanent.acquireBytes(100), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'dns' && error.retryExhausted === false);
  assert.equal(permanentResolutions, 1);

  let unknownResolutions = 0;
  const unknown = createPlatformFileDownloadResolver({ allowedOrigins: ['https://files.example.test'] }, {
    async resolveAddresses() { unknownResolutions++; throw new Error('hidden-hostname'); },
    request() { throw new Error('must not request'); },
  })(file);
  await assert.rejects(unknown.acquireBytes(100), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.stage === 'dns' && error.retryExhausted === false);
  assert.equal(unknownResolutions, 1);
});
