import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, createServer as createNetServer } from 'node:net'
import { request, createServer } from 'node:http'
import { isPublicWebAddress, resolvePublicWebDestination } from '../public-web-network.mjs'
import { RestrictedProviderEgress, restrictedProviderNetworkPolicy, buildRestrictedNetworkProbe } from '../typed-inspection-network.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const tunnel = (egress, authority) => new Promise((resolve, reject) => {
  const socket = connect(egress.port, '127.0.0.1'); socket.once('error', reject)
  socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
  socket.once('data', bytes => { socket.destroy(); resolve(bytes.toString().split('\r\n')[0]) })
})
const get = (egress, url, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: egress.port, path: url, headers, agent: false }, res => {
    let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }); req.on('error', reject); req.end()
})

test('public browsing excludes private, loopback, metadata, multicast and transition addresses', () => {
  for (const ip of ['0.0.0.0', '10.2.3.4', '100.100.100.200', '127.0.0.1', '169.254.169.254',
    '168.63.129.16', '172.16.1.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.1.2.3', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', 'ff02::1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) {
    assert.equal(isPublicWebAddress(ip), false, ip)
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicWebAddress(ip), true, ip)
})

test('DNS is checked once, mixed public/private answers are refused and public IPv4 is preferred', async () => {
  let calls = 0
  const result = await resolvePublicWebDestination('new-site.example', { timeoutMs: 1000, lookupFn: async () => {
    calls++; return [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }]
  } })
  assert.equal(calls, 1); assert.deepEqual(result, { address: '1.1.1.1', family: 4 })
  await assert.rejects(resolvePublicWebDestination('mixed.example', { timeoutMs: 1000, lookupFn: async () => [
    { address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }
  ] }), /PUBLIC_WEB_DESTINATION_DENIED/)
  await assert.rejects(resolvePublicWebDestination('slow.example', { timeoutMs: 5, lookupFn: () => new Promise(() => {}) }), /PUBLIC_WEB_DNS_TIMEOUT/)
})

test('new public HTTPS sites need no installation/domain entry; connect uses the pinned DNS address', async t => {
  const upstream = createNetServer(socket => socket.on('error', () => {})); await listen(upstream)
  const connected = []; let lookups = 0
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.example', publicWeb: true,
    networkConnectTimeoutMs: 1000, lookupFn: async (...args) => { lookups++; return lookup(...args) },
    connectFn: options => { connected.push(options); return connect(upstream.address().port, '127.0.0.1') } })
  t.after(async () => { await egress.dispose(); await close(upstream) }); await egress.start()
  assert.match(await tunnel(egress, 'unconfigured.example:443'), /200/)
  assert.deepEqual(connected, [{ host: '93.184.216.34', family: 4, port: 443 }]); assert.equal(lookups, 1)
  assert.equal(egress.policy.publicWeb, 'public-addresses-dns-pinned-v1')
})

test('private literals, names resolving private, malformed CONNECT and user-info never open an upstream', async t => {
  let connections = 0
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.example', publicWeb: true,
    networkConnectTimeoutMs: 1000, lookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
    connectFn: () => { connections++; throw new Error('must not connect') } })
  t.after(() => egress.dispose()); await egress.start()
  for (const target of ['127.0.0.1:443', '[::1]:443', 'metadata.example:443', 'user@public.example:443', 'public.example:99999', 'public.example:0']) {
    assert.match(await tunnel(egress, target), /403/, target)
  }
  assert.equal(connections, 0)
})

test('ordinary HTTP works without a site list; proxy credentials are removed and redirected private targets stay denied', async t => {
  const received = []
  const upstream = createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers }); res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end('public page')
  }); await listen(upstream)
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.example', publicWeb: true,
    networkConnectTimeoutMs: 1000, lookupFn: lookup, httpRequestFn: (options, cb) => {
      assert.equal(options.host, '93.184.216.34'); assert.equal(options.family, 4)
      return request({ ...options, host: '127.0.0.1', port: upstream.address().port }, cb)
    } })
  t.after(async () => { await egress.dispose(); await close(upstream) }); await egress.start()
  const page = await get(egress, 'http://unconfigured.example/path?q=1', { 'Proxy-Authorization': 'fixture-secret', 'Proxy-Connection': 'keep-alive', Host: 'forged.example' })
  assert.equal(page.status, 302); assert.equal(page.body, 'public page'); assert.equal(received[0].path, '/path?q=1')
  assert.equal(received[0].headers.host, 'unconfigured.example'); assert.equal(received[0].headers['proxy-authorization'], undefined)
  assert.equal((await get(egress, page.headers.location)).status, 403); assert.equal(received.length, 1)
  assert.equal((await get(egress, 'http://user:pass@unconfigured.example/')).status, 403)
})

test('ordinary discussion/inspection retains its existing Provider-only policy', async t => {
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.example', networkConnectTimeoutMs: 1000,
    lookupFn: () => { throw new Error('restricted mode must not resolve arbitrary sites') } })
  t.after(() => egress.dispose()); await egress.start()
  assert.equal(restrictedProviderNetworkPolicy('https://provider.example', { connectTimeoutMs: 1000 }).publicWeb, undefined)
  assert.match(await tunnel(egress, 'unconfigured.example:443'), /403/)
  assert.equal((await get(egress, 'http://unconfigured.example/')).status, 403)
})

test('disposing during DNS resolution cannot open a late socket', async () => {
  let resolved, began, connections = 0
  const started = new Promise(resolve => { began = resolve })
  const egress = new RestrictedProviderEgress({ providerBaseUrl: 'https://provider.example', publicWeb: true, networkConnectTimeoutMs: 1000,
    lookupFn: () => new Promise(resolve => { resolved = resolve; began() }), connectFn: () => { connections++; throw new Error('late connection') } })
  await egress.start(); const client = connect(egress.port, '127.0.0.1'); client.on('error', () => {})
  client.once('connect', () => client.write('CONNECT new.example:443 HTTP/1.1\r\n\r\n'))
  await started; await egress.dispose(); resolved([{ address: '1.1.1.1', family: 4 }])
  await new Promise(resolve => setImmediate(resolve)); client.destroy(); assert.equal(connections, 0)
})

test('public mode namespace attestation probes a real metadata address, not just an unresolvable name', () => {
  const probe = buildRestrictedNetworkProbe({ timeoutSeconds: 1, proxyPort: 1234, canaryPort: 2345, publicWeb: true })
  assert.match(probe, /CONNECT 169\.254\.169\.254:443/)
  assert.doesNotMatch(probe, /forbidden\.invalid/)
  assert.match(probe, /b' 403 '/)
})
