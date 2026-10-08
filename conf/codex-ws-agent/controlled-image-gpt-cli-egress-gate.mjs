import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const JSON_CONTENT = /^application\/json(?:\s*;|$)/i
const MULTIPART = /^multipart\/form-data(?:\s*;|$)/i
const ALLOWED_FIELDS = new Set(['model', 'prompt', 'n', 'size', 'quality', 'output_format', 'image', 'image[]'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export class ControlledImageGptCliGateError extends Error {
  constructor (code, message) { super(message); this.name = 'ControlledImageGptCliGateError'; this.code = code }
}
const fail = (code, message) => { throw new ControlledImageGptCliGateError(code, message) }

const readBody = request => new Promise((resolve, reject) => {
  const chunks = []
  request.on('data', chunk => chunks.push(Buffer.from(chunk)))
  request.once('end', () => resolve(Buffer.concat(chunks)))
  request.once('error', reject)
  request.once('aborted', () => reject(new Error('request aborted')))
})

const exactScalarFields = (lookup, expected) => {
  if (lookup('model') !== expected.modelId || lookup('prompt') !== expected.prompt
      || lookup('n') !== '1' || lookup('output_format') !== 'png'
      || lookup('size') !== 'auto' || lookup('quality') !== 'medium') {
    fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI request fields do not match the claimed command')
  }
}

const validateJson = (body, expected) => {
  let value
  try { value = JSON.parse(body.toString('utf8')) } catch { fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI generation body is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI generation body is invalid')
  const keys = Object.keys(value)
  if (keys.some(key => !ALLOWED_FIELDS.has(key)) || keys.some(key => key === 'image' || key === 'image[]')) {
    fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI generation body contains unsupported fields')
  }
  exactScalarFields(key => String(value[key] ?? ''), expected)
  if (expected.inputs.length !== 0) fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI generation request omitted claimed inputs')
}

const validateMultipart = async (contentType, body, expected) => {
  let form
  try {
    form = await new Request('http://127.0.0.1/validate', { method: 'POST', headers: { 'content-type': contentType }, body }).formData()
  } catch { fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI edit body is not valid multipart data') }
  const entries = [...form.entries()]
  if (entries.some(([key]) => !ALLOWED_FIELDS.has(key))) fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI edit body contains unsupported fields')
  const scalars = new Map(entries.filter(([, value]) => typeof value === 'string'))
  exactScalarFields(key => scalars.get(key) || '', expected)
  const images = entries.filter(([key, value]) => (key === 'image' || key === 'image[]') && typeof value !== 'string')
  if (images.length !== expected.inputs.length || images.length === 0) {
    fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI edit body has the wrong image cardinality')
  }
  for (let index = 0; index < images.length; index++) {
    const bytes = Buffer.from(await images[index][1].arrayBuffer())
    if (String(bytes.length) !== expected.inputs[index].byteLength || hash(bytes) !== expected.inputs[index].sha256) {
      fail('CONTROLLED_IMAGE_CLI_REQUEST_INVALID', 'image CLI edit bytes do not match the claimed input snapshot')
    }
  }
}

export class ControlledImageGptCliEgressGate {
  #endpoint; #credential; #expected; #fetch; #server; #token; #consumed = false
  #providerAttempts = 0; #localRequests = 0; #providerOutcome = 'NOT_ATTEMPTED'

  constructor ({ endpoint, credential, expected, fetchFn = globalThis.fetch } = {}) {
    if (typeof endpoint !== 'string' || typeof credential !== 'string' || !credential
        || !expected || !['/v1/images/generations', '/v1/images/edits'].includes(expected.path)
        || typeof expected.modelId !== 'string' || !expected.modelId || typeof expected.prompt !== 'string'
        || !expected.prompt || !Array.isArray(expected.inputs) || typeof fetchFn !== 'function') {
      fail('CONTROLLED_IMAGE_CLI_GATE_CONFIG_INVALID', 'controlled image CLI egress gate configuration is incomplete')
    }
    this.#endpoint = endpoint
    this.#credential = credential
    this.#expected = expected
    this.#fetch = fetchFn
    this.#token = randomBytes(32).toString('hex')
  }

  get providerAttempts () { return this.#providerAttempts }
  get localRequests () { return this.#localRequests }
  get providerOutcome () { return this.#providerOutcome }

  async start () {
    if (this.#server) fail('CONTROLLED_IMAGE_CLI_GATE_CONFIG_INVALID', 'controlled image CLI egress gate is already started')
    this.#server = createServer((request, response) => { void this.#handle(request, response) })
    this.#server.on('clientError', (_error, socket) => { socket.destroy() })
    await new Promise((resolveStart, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => { this.#server.off('error', reject); resolveStart() })
    })
    const address = this.#server.address()
    return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/v1`, token: this.#token })
  }

  async close () {
    if (!this.#server) return
    const server = this.#server
    this.#server = null
    await new Promise(resolveClose => server.close(() => resolveClose()))
  }

  async #handle (request, response) {
    this.#localRequests++
    const reject = (status = 400) => { response.statusCode = status; response.end('{"error":{"message":"controlled image CLI egress rejected"}}') }
    try {
      if (request.headers.authorization !== `Bearer ${this.#token}`) return reject(401)
      if (this.#consumed) return reject(400)
      this.#consumed = true
      if (request.method !== 'POST' || request.url !== this.#expected.path) return reject(400)
      const contentType = String(request.headers['content-type'] || '')
      const body = await readBody(request)
      if (this.#expected.path.endsWith('/generations')) {
        if (!JSON_CONTENT.test(contentType)) return reject(400)
        validateJson(body, this.#expected)
      } else {
        if (!MULTIPART.test(contentType)) return reject(400)
        await validateMultipart(contentType, body, this.#expected)
      }
      const endpoint = new URL(this.#expected.path, `${this.#endpoint}/`)
      this.#providerAttempts++
      let upstream
      try {
        upstream = await this.#fetch(endpoint, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${this.#credential}`, Accept: 'application/json', 'Content-Type': contentType },
          body
        })
      } catch {
        this.#providerOutcome = 'UNKNOWN'
        return reject(400)
      }
      this.#providerOutcome = `HTTP_${upstream.status}`
      response.statusCode = upstream.status
      const upstreamType = upstream.headers?.get?.('content-type')
      if (upstreamType) response.setHeader('content-type', upstreamType)
      const bytes = Buffer.from(await upstream.arrayBuffer())
      response.end(bytes)
    } catch {
      reject(400)
    }
  }
}
