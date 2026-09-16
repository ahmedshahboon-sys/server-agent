import test from 'node:test';
import assert from 'node:assert/strict';
import { FetchHttpProbe, isPublicNetworkAddress, type HostResolver } from '../../src/health/health-service.js';

test('health SSRF guard rejects hostnames that resolve to private addresses before connecting', async () => {
  const resolver: HostResolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const result = await new FetchHttpProbe(resolver).check(new URL('https://public-looking.example/health'), 1000, [200]);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, null);
  assert.match(result.error ?? '', /private or reserved/i);
});

test('health SSRF guard rejects mixed public/private DNS answers to prevent rebinding ambiguity', async () => {
  const resolver: HostResolver = async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.10.10.10', family: 4 }];
  const result = await new FetchHttpProbe(resolver).check(new URL('https://mixed.example/health'), 1000, [200]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /private or reserved/i);
});

test('network address classifier blocks loopback, RFC1918, link-local and IPv6 local ranges', () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254']) assert.equal(isPublicNetworkAddress(address), false, address);
  for (const address of ['::1','fc00::1','fe80::1','2001:db8::1']) assert.equal(isPublicNetworkAddress(address), false, address);
  assert.equal(isPublicNetworkAddress('1.1.1.1'), true);
  assert.equal(isPublicNetworkAddress('2606:4700:4700::1111'), true);
});
