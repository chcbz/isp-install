#!/usr/bin/env node
// This script is a standalone skill helper, not a bridge runner or completion authority.
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, unlinkSync, fstatSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as http from 'node:http'
import { normalizeImageInput, parseImageOutputSize, resizeImageOutput } from './image-input.mjs'
import { responsePng } from './image-http-codec.mjs'

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_EDIT_URL = 20_971_520 // Existing provider protocol envelope.
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])

function argumentsOf(argv) {
  const [mode, ...rest] = argv
  if (!['generate', 'edit', 'resize'].includes(mode)) fail('IMAGE_ARGUMENT_INVALID', 'Expected generate, edit or resize')
  const args = { mode, inputs: [] }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1]
    if (!['--prompt', '--output', '--size', '--input', '--config'].includes(key) || value === undefined || value.startsWith('--')) fail('IMAGE_ARGUMENT_INVALID', 'Invalid CLI arguments')
    if (key === '--input') args.inputs.push(value)
    else {
      const name = key.slice(2)
      if (Object.hasOwn(args, name)) fail('IMAGE_ARGUMENT_INVALID', 'Duplicate CLI argument')
      args[name] = value
    }
  }
  if (!args.output || (mode !== 'resize' && !args.prompt?.trim()) || (mode === 'resize' && (args.prompt !== undefined || args.config !== undefined || args.size === undefined)) || (mode === 'generate' && args.inputs.length) || (mode === 'edit' && (!args.inputs.length || args.inputs.length > 16)) || (mode === 'resize' && args.inputs.length !== 1)) fail('IMAGE_ARGUMENT_INVALID', 'Required or incompatible CLI arguments')
  args.output = resolve(args.output)
  args.outputSize = parseImageOutputSize(args.size)
  return args
}

function reserve(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  return { path, fd, identity: fstatSync(fd), keep: false }
}
function release(file) {
  if (!file) return
  closeSync(file.fd)
  if (!file.keep) {
    try { const now = lstatSync(file.path); if (now.dev === file.identity.dev && now.ino === file.identity.ino) unlinkSync(file.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
function save(file, bytes) { writeFileSync(file.fd, bytes); fsyncSync(file.fd); file.keep = true }
function result(path, bytes, originalPath) {
  return { path, contentMimeType: 'image/png', sha256: hash(bytes), byteLength: String(bytes.length), ...(originalPath ? { providerImagePath: originalPath } : {}) }
}

export async function run(argv, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const args = argumentsOf(argv)
  if (args.mode === 'resize') {
    const bytes = readFileSync(args.inputs[0])
    const resized = resizeImageOutput(bytes, args.outputSize)
    let output
    try { output = reserve(args.output); save(output, resized); return result(args.output, resized) } finally { release(output) }
  }
  let config
  const configPath = args.config || (env.CYF_SKILL_CONFIG_DIR && resolve(env.CYF_SKILL_CONFIG_DIR, 'native-image.json'))
  if (configPath) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { fail('IMAGE_CONFIG_MISSING', 'Image skill configuration could not be read') }
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('IMAGE_CONFIG_INVALID', 'Image skill configuration is invalid')
  } else config = { endpoint: env.IMAGE_API_ENDPOINT, model: env.IMAGE_API_MODEL, apiKey: env.IMAGE_API_KEY }
  const { endpoint: endpointText, model, apiKey: credential } = config
  if (![endpointText, model, credential].every(value => typeof value === 'string' && value.trim())) fail('IMAGE_CONFIG_MISSING', 'Image service configuration is unavailable')
  let endpoint
  try {
    const base = new URL(endpointText)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('invalid')
    endpoint = new URL(args.mode === 'edit' ? '/v1/images/edits' : '/v1/images/generations', base)
  } catch { fail('IMAGE_CONFIG_INVALID', 'Image service endpoint is invalid') }
  const images = args.inputs.map(path => {
    const normalized = normalizeImageInput(readFileSync(path))
    const image_url = `data:${normalized.mimeType};base64,${normalized.bytes.toString('base64')}`
    if (image_url.length > MAX_EDIT_URL) fail('IMAGE_INPUT_TOO_LARGE', 'Image is too large for the existing provider envelope')
    return { image_url }
  })
  const body = { model, prompt: args.prompt, ...(images.length ? { images } : {}), n: 1, output_format: 'png' }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('IMAGE_TLS_INSECURE', 'TLS verification must be enabled')
  const httpProxy = env.http_proxy || env.HTTP_PROXY, httpsProxy = env.https_proxy || env.HTTPS_PROXY
  const proxy = endpoint.protocol === 'https:' ? httpsProxy : httpProxy
  if ((httpProxy || httpsProxy) && !proxy) fail('IMAGE_PROXY_CONFIG_INVALID', 'Proxy for endpoint scheme is missing')
  let output, original, marker, gotBytes = false, restoreProxy
  try {
    if (proxy) {
      if (typeof http.setGlobalProxyFromEnv !== 'function') fail('IMAGE_PROXY_UNAVAILABLE', 'Node runtime does not support configured proxy')
      // Do not honor NO_PROXY as a way around the execution environment's proxy.
      try { restoreProxy = http.setGlobalProxyFromEnv({ http_proxy: httpProxy, https_proxy: httpsProxy, no_proxy: ' ' }) }
      catch { fail('IMAGE_PROXY_CONFIG_INVALID', 'Proxy configuration is invalid') }
    }
    output = reserve(args.output)
    if (args.outputSize) original = reserve(`${args.output}.provider.png`)
    // A durable, output-bound start marker stops same-command replay after a
    // process disconnect. A different output is not proof of new authorization.
    try { marker = reserve(`${args.output}.request-started`) } catch (error) {
      if (error.code === 'EEXIST') fail('IMAGE_REQUEST_EXISTS', 'Request already started; do not automatically resend')
      throw error
    }
    marker.keep = true
    save(marker, Buffer.from('REQUEST_STARTED\n'))
    const directoryFd = openSync(dirname(args.output), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    let response
    try {
      response = await fetchFn(endpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    } catch (error) {
      const transportCode = error?.cause?.code || error?.code
      fail('IMAGE_OUTCOME_UNKNOWN', 'Provider request failed; outcome is unknown; do not automatically resend', { outcome: 'UNKNOWN', ...(TRANSPORT_CODES.has(transportCode) ? { transportCode } : {}) })
    }
    const bytes = await responsePng(response, endpoint)
    gotBytes = true
    if (original) save(original, bytes)
    const transformed = resizeImageOutput(bytes, args.outputSize)
    save(output, transformed)
    return result(args.output, transformed, original?.path)
  } catch (error) {
    if (gotBytes) {
      error.outcome = 'RESPONSE_RECEIVED'
      if (original?.keep) error.providerImagePath = original.path
    }
    throw error
  } finally { try { release(marker); release(original); release(output) } finally { restoreProxy?.() } }
}

// Diagnostics deliberately exclude provider body, URL, prompt, credentials and exception text.
const messages = {
  IMAGE_ARGUMENT_INVALID: 'Invalid CLI arguments', SKILL_IMAGE_SIZE_INVALID: 'Invalid image size',
  IMAGE_CONFIG_MISSING: 'Image service configuration is unavailable', IMAGE_CONFIG_INVALID: 'Image service configuration is invalid',
  IMAGE_PROXY_UNAVAILABLE: 'Node runtime does not support configured proxy', IMAGE_PROXY_CONFIG_INVALID: 'Proxy configuration is invalid', IMAGE_TLS_INSECURE: 'TLS verification must be enabled',
  IMAGE_REQUEST_EXISTS: 'Request already started; do not automatically resend',
  IMAGE_INPUT_TOO_LARGE: 'Image is too large for the provider envelope', IMAGE_OUTCOME_UNKNOWN: 'Provider outcome unknown; do not automatically resend',
  IMAGE_PROVIDER_REJECTED: 'Provider did not return a direct 200 response', IMAGE_RESPONSE_INVALID: 'Invalid Provider response; outcome unknown',
  SKILL_IMAGE_OUTPUT_RESIZE_FAILED: 'Local resizing failed; do not regenerate', EEXIST: 'Output already exists',
  IMAGE_INPUT_INVALID: 'Invalid image input', IMAGE_FORMAT_UNSUPPORTED: 'Unsupported image input format', IMAGE_MULTIFRAME_REQUIRES_SELECTION: 'Select a static frame or page', IMAGE_DECODE_FAILED: 'Image input decode failed', ENOENT: 'Input or output directory is unavailable'
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`) }
  catch (error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'IMAGE_OPERATION_FAILED'
    const diagnostic = { code, message: messages[code] || 'Image operation failed; do not automatically resend', ...(error?.outcome ? { outcome: error.outcome } : {}), ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(TRANSPORT_CODES.has(error?.transportCode) ? { transportCode: error.transportCode } : {}), ...(error?.providerImagePath ? { providerImagePath: error.providerImagePath } : {}) }
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`); process.exitCode = 1
  }
}
