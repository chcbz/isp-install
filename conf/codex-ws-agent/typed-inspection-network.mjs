import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'

const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error }
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const processStat = pid => {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)
  return { ppid: Number(fields[1]), startticks: fields[19] }
}
const namespaceIdentity = pid => { const stat = statSync(`/proc/${pid}/ns/net`, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino), link: readlinkSync(`/proc/${pid}/ns/net`) } }
const sameNamespace = (left, right) => left.dev === right.dev && left.ino === right.ino && left.link === right.link
const digestHex = value => String(value || '').replace(/^sha256:/, '')
const sameExecutable = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && digestHex(left.sha256) === digestHex(right.sha256)
const descendantOf = (pid, rootPid) => {
  let current = pid; const seen = new Set()
  while (current > 1 && !seen.has(current)) { if (current === rootPid) return true; seen.add(current); try { current = processStat(current).ppid } catch { return false } }
  return false
}
const defaultProcessInspector = Object.freeze({
  currentPid: () => process.pid,
  stat: processStat,
  namespace: namespaceIdentity,
  executable: pid => { const stat = statSync(`/proc/${pid}/exe`, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: `sha256:${sha256File(`/proc/${pid}/exe`)}` } },
  pids: () => readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value)).map(Number),
  descendantOf
})
const exactAuthority = url => `${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${url.port || '443'}`.toLowerCase()
const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const cancelled = signal => {
  if (signal?.aborted) fail('TYPED_INSPECTION_EGRESS_CANCELLED')
}
const poll = signal => new Promise((resolve, reject) => {
  if (signal?.aborted) { const error = new Error('TYPED_INSPECTION_EGRESS_CANCELLED'); error.code = 'TYPED_INSPECTION_EGRESS_CANCELLED'; reject(error); return }
  const timer = setTimeout(done, 10)
  const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); const error = new Error('TYPED_INSPECTION_EGRESS_CANCELLED'); error.code = 'TYPED_INSPECTION_EGRESS_CANCELLED'; reject(error) }
  function done() { signal?.removeEventListener('abort', aborted); resolve() }
  signal?.addEventListener('abort', aborted, { once: true })
})

export const buildProviderTlsProbe = ({ timeoutSeconds, proxyPort, authority, host, caPath }) => String.raw`import socket,ssl,sys,json,hashlib
t=${JSON.stringify(timeoutSeconds)};proxy=('10.0.2.2',${proxyPort});authority=${JSON.stringify(authority)};host=${JSON.stringify(host)};ca=${JSON.stringify(caPath)}
s=socket.create_connection(proxy,t);s.settimeout(t);s.sendall(('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n\r\n').encode('ascii'));d=b''
while b'\r\n\r\n' not in d and len(d)<4096:
 chunk=s.recv(4096)
 if not chunk:break
 d+=chunk
if b' 200 ' not in d.split(b'\r\n',1)[0]:print(d[:128].decode('ascii','replace'));sys.exit(9)
ctx=ssl.create_default_context(cafile=ca);tls=ctx.wrap_socket(s,server_hostname=host);cert=tls.getpeercert(binary_form=True);print(json.dumps({'protocol':tls.version(),'peerCertificateSha256':'sha256:'+hashlib.sha256(cert).hexdigest()}));tls.close()
`

export const restrictedProviderNetworkPolicy = (baseUrl, { connectTimeoutMs } = {}) => {
  let url
  try { url = new URL(baseUrl) } catch { fail('TYPED_INSPECTION_PROVIDER_ORIGIN_REQUIRED') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('TYPED_INSPECTION_PROVIDER_ORIGIN_REQUIRED')
  if (!positiveInteger(connectTimeoutMs)) fail('TYPED_INSPECTION_NETWORK_CONNECT_TIMEOUT_REQUIRED')
  return Object.freeze({
    schemaVersion: 1,
    providerOrigin: url.origin,
    providerAuthority: exactAuthority(url),
    transport: 'fixed-connect-proxy-v1',
    connectTimeoutMs: String(connectTimeoutMs),
    namespace: 'private-slirp4netns-v1',
    directEgress: 'nft-default-drop-readback-v1',
    hostLoopback: 'proxy-port-only',
    dns: 'proxy-side-only'
  })
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()) })
})
const closeServer = server => new Promise(resolve => {
  try { server.closeAllConnections?.() } catch {}
  server.close(() => resolve())
})
const collectChild = (child, signal, input = null) => new Promise((resolve, reject) => {
  let stdout = ''; let stderr = ''; let settled = false
  const cleanup = () => { signal?.removeEventListener('abort', abort); child.off('error', error); child.off('exit', exit) }
  const finish = (callback, value) => { if (settled) return; settled = true; cleanup(); callback(value) }
  const abort = () => { try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}; const errorValue = new Error('TYPED_INSPECTION_EGRESS_CANCELLED'); errorValue.code = 'TYPED_INSPECTION_EGRESS_CANCELLED'; finish(reject, errorValue) }
  const error = value => finish(reject, value)
  const exit = (status, exitSignal) => finish(resolve, { status, signal: exitSignal, stdout, stderr })
  child.stdout?.on('data', chunk => { if (stdout.length < 65536) stdout += chunk.toString('utf8') })
  child.stderr?.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString('utf8') })
  child.once('error', error); child.once('exit', exit); signal?.addEventListener('abort', abort, { once: true })
  if (input === null) child.stdin?.end(); else child.stdin?.end(input)
})
const waitForSlirpReady = (child, signal) => new Promise((resolve, reject) => {
  let settled = false; const ready = child.stdio?.[3]
  const cleanup = () => { signal?.removeEventListener('abort', abort); child.off('error', error); child.off('exit', exit); ready?.off('data', data) }
  const finish = (callback, value) => { if (settled) return; settled = true; cleanup(); callback(value) }
  const abort = () => { try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}; const value = new Error('TYPED_INSPECTION_EGRESS_CANCELLED'); value.code = 'TYPED_INSPECTION_EGRESS_CANCELLED'; finish(reject, value) }
  const error = value => finish(reject, value)
  const exit = () => { const value = new Error('TYPED_INSPECTION_EGRESS_SLIRP_FAILED'); value.code = 'TYPED_INSPECTION_EGRESS_SLIRP_FAILED'; finish(reject, value) }
  const data = chunk => { if (chunk.length > 0) finish(resolve) }
  if (!ready) { const value = new Error('TYPED_INSPECTION_EGRESS_SLIRP_READY_FD_MISSING'); value.code = 'TYPED_INSPECTION_EGRESS_SLIRP_READY_FD_MISSING'; reject(value); return }
  child.once('error', error); child.once('exit', exit); ready.once('data', data); signal?.addEventListener('abort', abort, { once: true })
})
const hostCanaryControl = (port, timeoutMs) => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1'); let received = ''
  socket.setTimeout(timeoutMs)
  socket.on('data', chunk => { received += chunk.toString('utf8') })
  socket.once('timeout', () => { socket.destroy(); reject(Object.assign(new Error('TYPED_INSPECTION_EGRESS_HOST_CANARY_TIMEOUT'), { code: 'TYPED_INSPECTION_EGRESS_HOST_CANARY_TIMEOUT' })) })
  socket.once('error', reject)
  socket.once('close', () => {
    if (received === 'cyf-typed-inspection-host-canary\n') resolve(Object.freeze({ reachable: true, port }))
    else reject(Object.assign(new Error('TYPED_INSPECTION_EGRESS_HOST_CANARY_INVALID'), { code: 'TYPED_INSPECTION_EGRESS_HOST_CANARY_INVALID' }))
  })
})
const chainBody = (readback, name) => {
  const match = readback.match(new RegExp(`chain\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))
  return match?.[1] || ''
}
export const verifyRestrictedNftReadback = (readback, proxyPort, canaryPort) => {
  const input = chainBody(readback, 'input'); const output = chainBody(readback, 'output')
  const inputAccepts = input.split(/\r?\n/).map(line => line.trim()).filter(line => /\baccept\b/.test(line))
  const outputAccepts = output.split(/\r?\n/).map(line => line.trim()).filter(line => /\baccept\b/.test(line))
  const proxyRule = new RegExp(`^ip daddr 10\\.0\\.2\\.2 tcp dport ${proxyPort} accept$`)
  if (!/policy drop;/.test(input) || !/policy drop;/.test(output) || inputAccepts.length !== 2 || outputAccepts.length !== 3 ||
      !inputAccepts.includes('ct state established,related accept') || !inputAccepts.includes('iifname "lo" accept') ||
      !outputAccepts.includes('ct state established,related accept') || !outputAccepts.includes('oifname "lo" accept') ||
      !outputAccepts.some(line => proxyRule.test(line)) || readback.includes(`dport ${canaryPort}`)) fail('TYPED_INSPECTION_EGRESS_NFT_READBACK_MISMATCH')
  return Object.freeze({ validated: true, digest: `sha256:${createHash('sha256').update(readback).digest('hex')}` })
}

export class RestrictedProviderEgress {
  constructor({ providerBaseUrl, networkConnectTimeoutMs, slirpBin = '/usr/bin/slirp4netns', nftBin = '/usr/sbin/nft', nsenterBin = '/usr/bin/nsenter', pythonBin = '/usr/bin/python3', spawnFn = spawn, processInspector = defaultProcessInspector } = {}) {
    this.policy = restrictedProviderNetworkPolicy(providerBaseUrl, { connectTimeoutMs: networkConnectTimeoutMs })
    this.networkConnectTimeoutMs = networkConnectTimeoutMs
    this.slirpBin = slirpBin; this.nftBin = nftBin; this.nsenterBin = nsenterBin; this.pythonBin = pythonBin
    this.spawnFn = spawnFn; this.processInspector = processInspector; this.server = null; this.canaryServer = null; this.slirp = null; this.port = 0; this.canaryPort = 0; this.attestation = null; this.owner = null; this.hostCanary = null
    this.lifecycle = new AbortController()
  }
  async bindOwner(child, expectedWrapperExecutable, expectedSandboxExecutable, { signal = this.lifecycle.signal } = {}) {
    if (this.owner || !child || !Number.isInteger(child.pid) || child.pid <= 0 || !expectedWrapperExecutable?.sha256 || !expectedSandboxExecutable?.sha256) fail('TYPED_INSPECTION_EGRESS_OWNER_INVALID')
    cancelled(signal)
    const inspector = this.processInspector; const currentPid = inspector.currentPid(); const rootPid = child.pid; const hostNamespace = inspector.namespace(currentPid)
    const rootStat = inspector.stat(rootPid); const rootExecutable = inspector.executable(rootPid)
    if (rootStat.ppid !== currentPid || child.exitCode !== null || !sameExecutable(rootExecutable, expectedWrapperExecutable)) fail('TYPED_INSPECTION_EGRESS_OWNER_INVALID')
    let holder = null
    while (!holder) {
      cancelled(signal)
      if (child.exitCode !== null) fail('TYPED_INSPECTION_EGRESS_OWNER_LOST')
      const candidates = []
      for (const pid of inspector.pids()) {
        if (pid === rootPid || !inspector.descendantOf(pid, rootPid)) continue
        try {
          const executable = inspector.executable(pid)
          if (!sameExecutable(executable, expectedSandboxExecutable)) continue
          const namespace = inspector.namespace(pid); const stat = inspector.stat(pid)
          if (sameNamespace(namespace, hostNamespace)) fail('TYPED_INSPECTION_EGRESS_SANDBOX_NAMESPACE_SHARED')
          candidates.push({ pid, startticks: stat.startticks, namespace, executable })
        } catch (error) {
          if (['TYPED_INSPECTION_EGRESS_SANDBOX_NAMESPACE_SHARED'].includes(error?.code)) throw error
        }
      }
      if (candidates.length > 1) fail('TYPED_INSPECTION_EGRESS_OWNER_AMBIGUOUS')
      holder = candidates[0] || null
      if (!holder) await poll(signal)
    }
    this.owner = Object.freeze({ child, rootPid, rootStartticks: rootStat.startticks, rootPpid: rootStat.ppid, rootExecutable: Object.freeze({ ...rootExecutable }), hostNamespace: Object.freeze({ ...hostNamespace }), holder: Object.freeze({ ...holder, namespace: Object.freeze({ ...holder.namespace }), executable: Object.freeze({ ...holder.executable }) }) })
    this._assertOwner()
    return Object.freeze({ rootPid, rootStartticks: rootStat.startticks, pid: holder.pid, startticks: holder.startticks, namespace: Object.freeze({ ...holder.namespace }) })
  }
  _assertOwner() {
    const owner = this.owner; const inspector = this.processInspector; const currentPid = inspector.currentPid()
    if (!owner || owner.child.pid !== owner.rootPid || owner.child.exitCode !== null) fail('TYPED_INSPECTION_EGRESS_OWNER_LOST')
    let rootStat; let rootExecutable; let holderStat; let holderNamespace; let holderExecutable; let currentNamespace
    try {
      rootStat = inspector.stat(owner.rootPid); rootExecutable = inspector.executable(owner.rootPid)
      holderStat = inspector.stat(owner.holder.pid); holderNamespace = inspector.namespace(owner.holder.pid); holderExecutable = inspector.executable(owner.holder.pid); currentNamespace = inspector.namespace(currentPid)
    } catch { fail('TYPED_INSPECTION_EGRESS_OWNER_LOST') }
    if (rootStat.startticks !== owner.rootStartticks || rootStat.ppid !== owner.rootPpid || owner.rootPpid !== currentPid || !sameExecutable(rootExecutable, owner.rootExecutable) ||
        holderStat.startticks !== owner.holder.startticks || !sameNamespace(holderNamespace, owner.holder.namespace) || sameNamespace(holderNamespace, currentNamespace) || !sameNamespace(currentNamespace, owner.hostNamespace) ||
        !sameExecutable(holderExecutable, owner.holder.executable) || !inspector.descendantOf(owner.holder.pid, owner.rootPid)) fail('TYPED_INSPECTION_EGRESS_OWNER_DRIFT')
    for (const pid of inspector.pids()) {
      let candidate
      try { candidate = inspector.namespace(pid) } catch { continue }
      if (sameNamespace(candidate, owner.holder.namespace) && !inspector.descendantOf(pid, owner.rootPid)) fail('TYPED_INSPECTION_EGRESS_NAMESPACE_FOREIGN_PROCESS')
    }
    return owner
  }
  async start() {
    if (this.server) return this
    const server = createHttpServer((_request, response) => { response.writeHead(405, { Connection: 'close' }); response.end() })
    server.on('connect', (request, client, head) => {
      if (String(request.url || '').toLowerCase() !== this.policy.providerAuthority) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      const provider = new URL(this.policy.providerOrigin); const upstream = connect(Number(provider.port || 443), provider.hostname)
      const abort = () => { try { client.destroy() } catch {}; try { upstream.destroy() } catch {} }
      upstream.setTimeout(this.networkConnectTimeoutMs, abort); upstream.once('error', abort); client.once('error', abort)
      upstream.once('connect', () => {
        upstream.setTimeout(0); client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client)
      })
    })
    const canaryServer = createNetServer(socket => socket.end('cyf-typed-inspection-host-canary\n'))
    try {
      const address = await listen(server); const canaryAddress = await listen(canaryServer)
      this.server = server; this.port = address.port; this.canaryServer = canaryServer; this.canaryPort = canaryAddress.port
      this.hostCanary = await hostCanaryControl(this.canaryPort, this.networkConnectTimeoutMs)
      return this
    } catch (error) {
      await closeServer(server).catch(() => {}); await closeServer(canaryServer).catch(() => {}); throw error
    }
  }
  get proxyUrl() { if (!this.port) fail('TYPED_INSPECTION_EGRESS_NOT_STARTED'); return `http://10.0.2.2:${this.port}` }
  async _nsenter(pid, args, { input = null, signal = this.lifecycle.signal } = {}) {
    cancelled(signal); this._assertOwner()
    const child = this.spawnFn(this.nsenterBin, [`--net=/proc/${pid}/ns/net`, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '' } })
    const result = await collectChild(child, signal, input)
    this._assertOwner(); return result
  }
  async attach({ signal = this.lifecycle.signal } = {}) {
    if (!this.server || !this.canaryServer || !this.hostCanary?.reachable) fail('TYPED_INSPECTION_EGRESS_ATTACH_INVALID')
    cancelled(signal); const owner = this._assertOwner(); const pid = owner.holder.pid
    const rules = `table inet cyf_typed_inspection {\n chain input { type filter hook input priority 0; policy drop; ct state established,related accept; iifname "lo" accept; }\n chain output { type filter hook output priority 0; policy drop; ct state established,related accept; oifname "lo" accept; ip daddr 10.0.2.2 tcp dport ${this.port} accept; }\n}\n`
    const applied = await this._nsenter(pid, [this.nftBin, '-f', '-'], { input: rules, signal })
    if (applied.status !== 0) fail('TYPED_INSPECTION_EGRESS_NFT_FAILED', applied.stderr || 'nft failed')
    const listed = await this._nsenter(pid, [this.nftBin, 'list', 'table', 'inet', 'cyf_typed_inspection'], { signal })
    if (listed.status !== 0) fail('TYPED_INSPECTION_EGRESS_NFT_READBACK_FAILED', listed.stderr || 'nft readback failed')
    const ruleReadback = verifyRestrictedNftReadback(listed.stdout, this.port, this.canaryPort)
    this._assertOwner()
    this.slirp = this.spawnFn(this.slirpBin, ['--configure', '--mtu=65520', '--disable-dns', '--enable-sandbox', '--enable-seccomp', '--ready-fd=3', String(pid), 'tap0'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: '' } })
    let stderr = ''; this.slirp.stderr?.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString('utf8') })
    try { await waitForSlirpReady(this.slirp, signal) } catch (error) { if (error.code === 'TYPED_INSPECTION_EGRESS_SLIRP_FAILED' && stderr.trim()) error.message = stderr.trim(); throw error }
    this._assertOwner()
    const routes = readFileSync(`/proc/${pid}/net/route`, 'utf8')
    if (!/\btap0\b/.test(routes)) fail('TYPED_INSPECTION_EGRESS_SLIRP_ROUTE_MISSING')
    const timeoutSeconds = this.networkConnectTimeoutMs / 1000
    const probe = `import socket,sys\nt=${JSON.stringify(timeoutSeconds)};p=${this.port};cport=${this.canaryPort}\ndef c(host,port,payload=b''):\n s=socket.socket();s.settimeout(t);r=s.connect_ex((host,port))\n if r: s.close();return ('blocked',b'')\n if payload:s.sendall(payload)\n try:d=s.recv(128)\n except Exception:d=b''\n s.close();return ('connected',d)\na=c('10.0.2.2',p,b'CONNECT forbidden.invalid:443 HTTP/1.1\\r\\nHost: forbidden.invalid:443\\r\\n\\r\\n')\nb=c('10.0.2.2',cport)\nc=c('1.1.1.1',443)\nprint(a[0],a[1].split(b'\\r\\n',1)[0].decode('ascii','replace'),b[0],c[0])\nsys.exit(0 if a[0]=='connected' and b' 403 ' in a[1] and b[0]=='blocked' and c[0]=='blocked' else 7)\n`
    const tested = await this._nsenter(pid, [this.pythonBin, '-c', probe], { signal })
    if (tested.status !== 0) fail('TYPED_INSPECTION_EGRESS_CANARY_FAILED', `${tested.stdout || ''}${tested.stderr || ''}`.trim())
    this._assertOwner()
    this.attestation = Object.freeze({ schemaVersion: 1, measured: true, policy: this.policy, hostCanaryReachableControl: true, forbiddenConnectRejected: true, otherHostPortBlocked: true, sandboxCanaryBlocked: true, nftDefaultDropReadback: true, nftRulesDigest: ruleReadback.digest, directInternetProbeBlocked: true, directInternetBlocked: true })
    return this.attestation
  }
  async measureAllowedConnect({ signal = this.lifecycle.signal } = {}) {
    const owner = this._assertOwner(); const provider = new URL(this.policy.providerOrigin); const authority = this.policy.providerAuthority; const timeoutSeconds = this.networkConnectTimeoutMs / 1000
    const probe = `import socket,sys\ns=socket.create_connection(('10.0.2.2',${this.port}),${JSON.stringify(timeoutSeconds)});s.sendall(b'CONNECT ${authority} HTTP/1.1\\r\\nHost: ${authority}\\r\\n\\r\\n');d=s.recv(128);print(d.split(b'\\r\\n',1)[0].decode('ascii','replace'));s.close();sys.exit(0 if b' 200 ' in d else 9)\n`
    const tested = await this._nsenter(owner.holder.pid, [this.pythonBin, '-c', probe], { signal })
    if (tested.status !== 0) fail('TYPED_INSPECTION_EGRESS_ALLOWED_CANARY_FAILED', `${tested.stdout || ''}${tested.stderr || ''}`.trim())
    this._assertOwner()
    return Object.freeze({ measured: true, providerAuthority: authority, connectEstablished: true, targetHost: provider.hostname, targetPort: Number(provider.port || 443) })
  }
  async measureAllowedTls({ sandboxPath, sha256: expectedDigest }, { signal = this.lifecycle.signal } = {}) {
    const owner = this._assertOwner(); const provider = new URL(this.policy.providerOrigin); const authority = this.policy.providerAuthority; const timeoutSeconds = this.networkConnectTimeoutMs / 1000
    if (sandboxPath !== '/trust/ca-bundle.pem' || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest || '')) fail('TYPED_INSPECTION_EGRESS_CA_BINDING_INVALID')
    const caPath = `/proc/${owner.holder.pid}/root${sandboxPath}`
    if (`sha256:${sha256File(caPath)}` !== expectedDigest) fail('TYPED_INSPECTION_EGRESS_CA_BINDING_INVALID')
    const probe = buildProviderTlsProbe({ timeoutSeconds, proxyPort: this.port, authority, host: provider.hostname, caPath })
    const tested = await this._nsenter(owner.holder.pid, [this.pythonBin, '-c', probe], { signal })
    if (tested.status !== 0) fail('TYPED_INSPECTION_EGRESS_TLS_FAILED', `${tested.stdout || ''}${tested.stderr || ''}`.trim())
    let readback; try { readback = JSON.parse(String(tested.stdout || '').trim()) } catch { fail('TYPED_INSPECTION_EGRESS_TLS_READBACK_INVALID') }
    if (!/^TLSv1\.[23]$/.test(readback?.protocol || '') || !/^sha256:[a-f0-9]{64}$/.test(readback?.peerCertificateSha256 || '')) fail('TYPED_INSPECTION_EGRESS_TLS_READBACK_INVALID')
    this._assertOwner()
    return Object.freeze({ measured: true, providerAuthority: authority, tlsVerified: true, protocol: readback.protocol, peerCertificateSha256: readback.peerCertificateSha256, caBundleSha256: expectedDigest })
  }
  async dispose() {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort()
    try { if (this.slirp?.exitCode === null) this.slirp.kill('SIGTERM') } catch {}
    this.slirp = null
    const servers = [this.server, this.canaryServer].filter(Boolean); this.server = null; this.canaryServer = null
    await Promise.all(servers.map(server => closeServer(server).catch(() => {})))
  }
}
