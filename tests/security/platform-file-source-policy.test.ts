import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  createPlatformFileDownloadResolver, inspectPlatformFileNetwork, PlatformFileDownloadError,
  validateFileSourcePolicy,
} from '../../src/adapters/mcp/platform-file-download.js';

const file = (host: string) => ({
  download_url: `https://${host}/private/original?sig=SIGNED_REFERENCE_SECRET`,
  file_id: 'private-file-identity',
});
const publicAddress = [{ address: '93.184.216.34', family: 4 as const }];
const officialPolicy = { allowedOrigins: [] as string[], fileSourcePolicy: 'chatgpt-official-v1' as const };

function transferFixture(addresses: { address: string; family: 4 | 6 }[] = publicAddress, status = 200) {
  const requests: { url: URL; options: RequestOptions }[] = [];
  const resolver = createPlatformFileDownloadResolver(officialPolicy, {
    async resolveAddresses() { return addresses; },
    request(url, options, onResponse) {
      requests.push({ url, options });
      const req = new EventEmitter() as ClientRequest;
      req.end = () => {
        const stream = new PassThrough();
        const response = stream as unknown as IncomingMessage;
        response.statusCode = status;
        process.nextTick(() => { onResponse(response); stream.end(Buffer.from([0, 255, 7])); });
        return req;
      };
      req.destroy = () => req;
      return req;
    },
  });
  return { resolver, requests };
}

test('explicit ChatGPT file source supports changing single-label OpenAI file hosts with pinned HTTPS', async () => {
  for (const host of ['sdmntprwestcentralus.oaiusercontent.com', 'sdmntprcentralus.oaiusercontent.com',
    'newregion-12.oaiusercontent.com']) {
    const { resolver, requests } = transferFixture();
    const transfer = resolver(file(host));
    assert.equal(transfer.referenceIdentity, createHash('sha256').update('private-file-identity').digest('hex'));
    assert.deepEqual(await transfer.acquireBytes(16), Buffer.from([0, 255, 7]));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url.hostname, host);
    assert.equal(requests[0]?.options.servername, host);
    assert.equal(requests[0]?.options.rejectUnauthorized, true);
    assert.equal(requests[0]?.options.method, 'GET');
    const address = await new Promise<string>((resolve, reject) => requests[0]?.options.lookup?.(
      host, {}, (error, selected) => error ? reject(error) : resolve(selected as string)));
    assert.equal(address, publicAddress[0]?.address);
  }
});

test('absent preset remains exact-only, including an empty list that disables downloads', () => {
  assert.throws(() => createPlatformFileDownloadResolver({ allowedOrigins: [] }), PlatformFileDownloadError);
  const exact = createPlatformFileDownloadResolver({
    allowedOrigins: ['https://sdmntprwestcentralus.oaiusercontent.com'],
  });
  exact(file('sdmntprwestcentralus.oaiusercontent.com'));
  assert.throws(() => exact(file('sdmntprcentralus.oaiusercontent.com')), (error: Error) =>
    error instanceof PlatformFileDownloadError && error.inputFailure === 'origin_not_allowed');
});

test('the fixed preset rejects aliases, neighboring domains, nested hosts and URL authority tricks before DNS', () => {
  let resolved = 0; let requested = 0; const rejected: string[] = [];
  const resolver = createPlatformFileDownloadResolver({ ...officialPolicy,
    onRejectedOrigin: origin => rejected.push(origin),
  }, {
    async resolveAddresses() { resolved++; return publicAddress; },
    request() { requested++; throw Error('Unexpected request'); },
  });
  for (const url of [
    'https://oaiusercontent.com/private?sig=secret',
    'https://a.b.oaiusercontent.com/private?sig=secret',
    'https://evil-oaiusercontent.com/private?sig=secret',
    'https://oaiusercontent.com.evil.test/private?sig=secret',
    'https://oaisdmntprwestus.blob.core.windows.net/private?sig=secret',
    'https://-bad.oaiusercontent.com/private?sig=secret',
    'https://bad-.oaiusercontent.com/private?sig=secret',
    `https://${'a'.repeat(64)}.oaiusercontent.com/private?sig=secret`,
    'https://user:password@a.oaiusercontent.com/private?sig=secret',
    'https://a.oaiusercontent.com:444/private?sig=secret',
    'https://a.oaiusercontent.com./private?sig=secret',
    'https://127.0.0.1/private?sig=secret',
    'http://a.oaiusercontent.com/private?sig=secret',
    'https://a.oaiusercontent.com/private#fragment',
  ]) assert.throws(() => resolver({ ...file('a.oaiusercontent.com'), download_url: url }), (error: Error) =>
    error instanceof PlatformFileDownloadError &&
    (error.inputFailure === 'origin_not_allowed' || error.inputFailure === 'invalid_url') &&
    !JSON.stringify(error).includes('secret'));
  assert.equal(resolved, 0); assert.equal(requested, 0);
  assert.ok(rejected.every(origin => !origin.includes('secret')));
});

test('the preset only accepts a literal canonical ASCII host authority', () => {
  let resolved = 0;
  const resolver = createPlatformFileDownloadResolver(officialPolicy, {
    async resolveAddresses() { resolved++; return publicAddress; },
    request() { throw Error('Unexpected request'); },
  });
  for (const download_url of [
    'https://%61.oaiusercontent.com/file',
    'https://A.oaiusercontent.com/file',
    'https://ä.oaiusercontent.com/file',
  ]) assert.throws(() => resolver({ ...file('a.oaiusercontent.com'), download_url }),
    PlatformFileDownloadError);
  resolver(file('a.oaiusercontent.com'));
  assert.equal(resolved, 0);
});

test('an unknown policy fails closed and cannot be echoed into errors', () => {
  const marker = 'PRIVATE_POLICY_VALUE';
  assert.equal(validateFileSourcePolicy(undefined), undefined);
  assert.equal(validateFileSourcePolicy('chatgpt-official-v1'), 'chatgpt-official-v1');
  for (const value of [null, marker, true, 'oaiusercontent.com']) {
    assert.throws(() => validateFileSourcePolicy(value), (error: Error) =>
      error instanceof PlatformFileDownloadError && !JSON.stringify(error).includes(marker));
    assert.throws(() => createPlatformFileDownloadResolver({ ...officialPolicy,
      fileSourcePolicy: value as never }), PlatformFileDownloadError);
  }
});

test('the official preset still rejects Fake-IP and mixed nonpublic DNS answers before GET', async () => {
  for (const addresses of [
    [{ address: '198.18.0.23', family: 4 as const }],
    [{ address: '93.184.216.34', family: 4 as const }, { address: '198.18.0.23', family: 4 as const }],
    [{ address: '10.2.3.4', family: 4 as const }],
    [{ address: '::1', family: 6 as const }],
  ]) {
    const { resolver, requests } = transferFixture(addresses);
    await assert.rejects(resolver(file('sdmntprcentralus.oaiusercontent.com')).acquireBytes(16),
      (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'address');
    assert.equal(requests.length, 0);
  }
});

test('the official preset does not follow redirects or retry permanent HTTPS responses', async () => {
  for (const status of [302, 401, 403]) {
    const { resolver, requests } = transferFixture(publicAddress, status);
    await assert.rejects(resolver(file('sdmntprcentralus.oaiusercontent.com')).acquireBytes(16),
      (error: Error) => error instanceof PlatformFileDownloadError && error.stage === 'http_status' &&
        error.retryExhausted === false);
    assert.equal(requests.length, 1);
  }
});

test('read-only network check requires a configured origin before any DNS query', async () => {
  let lookedUp = 0;
  const dependencies = { async resolveAddresses() { lookedUp++; return publicAddress; } };
  for (const origin of ['https://evil.test', 'https://sdmntprcentralus.oaiusercontent.com/path',
    'https://oaisdmntprwestus.blob.core.windows.net']) {
    await assert.rejects(inspectPlatformFileNetwork(origin, officialPolicy, dependencies),
      PlatformFileDownloadError);
  }
  await assert.rejects(inspectPlatformFileNetwork('https://sdmntprcentralus.oaiusercontent.com',
    { allowedOrigins: [] }, dependencies), PlatformFileDownloadError);
  assert.equal(lookedUp, 0);
});

test('network check classifies public, Fake-IP and unsupported results without HTTP', async () => {
  const origin = 'https://sdmntprcentralus.oaiusercontent.com';
  const statuses = [
    { addresses: publicAddress, status: 'public_ipv4' },
    { addresses: [{ address: '198.18.0.23', family: 4 as const }], status: 'fake_ip' },
    { addresses: [{ address: '198.19.255.250', family: 4 as const }], status: 'fake_ip' },
    { addresses: [{ address: '10.2.3.4', family: 4 as const }], status: 'non_public_or_unsupported' },
    { addresses: [{ address: '::1', family: 6 as const }], status: 'non_public_or_unsupported' },
    { addresses: [{ address: '198.18.0.23', family: 4 as const }, ...publicAddress],
      status: 'non_public_or_unsupported' },
    { addresses: [], status: 'non_public_or_unsupported' },
  ] as const;
  for (const { addresses, status } of statuses) {
    const result = await inspectPlatformFileNetwork(origin, officialPolicy,
      { resolveAddresses: async () => [...addresses] });
    assert.equal(result.status, status);
    assert.equal(result.dnsOnly, true);
    assert.doesNotMatch(JSON.stringify(result), /private|SIGNED_REFERENCE_SECRET|198\.18\.0\.23/u);
    if (status === 'fake_ip') assert.match(result.nextAction, /\*\.oaiusercontent\.com/);
  }
});

test('network check bounds DNS time and suppresses resolver error details', async () => {
  const origin = 'https://sdmntprcentralus.oaiusercontent.com';
  const never = new Promise<typeof publicAddress>(() => {});
  for (const resolveAddresses of [async () => { throw Error('PRIVATE_DNS_ERROR'); }, async () => never]) {
    const result = await inspectPlatformFileNetwork(origin, officialPolicy,
      { resolveAddresses, timeoutMs: 5 });
    assert.equal(result.status, 'dns_unavailable');
    assert.equal(result.dnsOnly, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DNS_ERROR|sdmntprcentralus/);
  }
});

test('a non-OpenAI exact origin never gets an unrelated OpenAI DNS exception recommendation', async () => {
  const result = await inspectPlatformFileNetwork('https://custom.example.test',
    { allowedOrigins: ['https://custom.example.test'] },
    { resolveAddresses: async () => [{ address: '198.18.0.25', family: 4 }] });
  assert.equal(result.status, 'fake_ip');
  assert.doesNotMatch(result.nextAction, /oaiusercontent|Mihomo/);
});
