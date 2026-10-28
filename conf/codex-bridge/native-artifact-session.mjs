/** Execution-bound draft snapshots/proposals. Not an API completion authority.
 * Only the native owner supplies this object to the engine's dynamic tool catalog. */
import { existsSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, constants } from 'node:fs'
import { resolve, basename } from 'node:path'
import { snapshotNativeArtifact } from './native-artifact-snapshot.mjs'
import { skillDigest, skillId } from './skill-executor.mjs'
import { validateSkillData } from './skill-manifest.mjs'

const fail = (code, recoverableToolError = false) => { throw Object.assign(new Error(code), { code, recoverableToolError }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const syncDir = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
const recoverableSource = code => ['ENOENT', 'ELOOP', 'ENOTDIR', 'NATIVE_ARTIFACT_PATH_INVALID', 'NATIVE_ARTIFACT_SOURCE_INVALID', 'NATIVE_ARTIFACT_SOURCE_CHANGED', 'NATIVE_OUTPUT_FORMAT_INVALID', 'NATIVE_OUTPUT_FORMAT_UNSUPPORTED'].includes(code)
export const nativeArtifactTools = Object.freeze([
  { type: 'function', name: 'artifact_stage', description: 'Freeze an actual file under /outputs as an execution-private candidate. This does not publish it to the user.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, displayName: { type: 'string' }, mediaTypeHint: { type: 'string' } }, required: ['path', 'displayName', 'mediaTypeHint'], additionalProperties: false } },
  { type: 'function', name: 'result_propose', description: 'Select already staged artifactRefs for the final result. A proposal is not an API completion receipt.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, artifactRefs: { type: 'array', items: { type: 'string' } }, data: {} }, required: ['summary', 'artifactRefs', 'data'], additionalProperties: false } }
])

export class NativeArtifactSession {
  constructor({ store, checkActive, validateSnapshot }) {
    this.store = store; this.command = store.command; this.checkActive = checkActive; this.validateSnapshot = validateSnapshot
    if (this.command.executionProtocolVersion !== 5 || typeof checkActive !== 'function' || typeof validateSnapshot !== 'function') fail('NATIVE_ARTIFACT_SESSION_INVALID')
  }
  policy() { return { executionId: this.command.executionId, tools: nativeArtifactTools, checkActive: this.checkActive, callTool: ctx => this.callTool(ctx) } }
  bindTurn({ threadId, turnId }) {
    this.checkActive()
    if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) fail('NATIVE_TURN_BINDING_INVALID')
    const binding = { executionId: this.command.executionId, threadId, turnId }
    const old = this.store.read('native-turn')
    if (old && skillDigest(old) !== skillDigest(binding)) fail('NATIVE_TURN_BINDING_CONFLICT')
    if (!old) this.store.write('native-turn', binding)
  }
  callTool(ctx) {
    this.checkActive()
    const binding = this.store.read('native-turn')
    if (!binding || ['executionId', 'threadId', 'turnId'].some(k => ctx[k] !== binding[k]) || typeof ctx.callId !== 'string' || !ctx.callId) fail('NATIVE_TOOL_BINDING_INVALID')
    if (!nativeArtifactTools.some(tool => tool.name === ctx.tool)) fail('NATIVE_TOOL_UNAVAILABLE')
    const key = `native-call-${skillDigest({ threadId: ctx.threadId, turnId: ctx.turnId, callId: ctx.callId })}`
    const requestSha256 = skillDigest({ tool: ctx.tool, arguments: ctx.arguments })
    const saved = this.store.read(key)
    if (saved && saved.requestSha256 !== requestSha256) fail('NATIVE_TOOL_CALL_CONFLICT')
    if (saved?.phase === 'DONE') {
      if (saved.proposal) this._select(saved.proposal)
      return saved.reply
    }
    if (saved?.phase === 'FAILED') fail(saved.code, true)
    if (this.store.read('result') || this.store.read('native-terminal')) fail('NATIVE_RESULT_ALREADY_FROZEN')
    if (saved?.phase === 'CAPTURED') return this._publish(key, saved)
    // A crash during snapshotting must not reread a subsequently modified draft.
    if (saved) fail('NATIVE_ARTIFACT_CAPTURE_UNKNOWN', true)
    const args = ctx.arguments
    if (!object(args)) fail('NATIVE_TOOL_ARGUMENTS_INVALID', true)
    if (ctx.tool === 'result_propose') return this._propose(key, requestSha256, args, binding)
    if (Object.keys(args).sort().join(',') !== 'displayName,mediaTypeHint,path' || typeof args.displayName !== 'string' || !args.displayName.trim()
        || /[\u0000-\u001f\u007f]/u.test(args.displayName) || !this.command.outputs.mimeTypes.includes(args.mediaTypeHint)) fail('NATIVE_TOOL_ARGUMENTS_INVALID', true)
    const started = { phase: 'STARTED', requestSha256 }
    this.store.write(key, started)
    let snapshot
    try {
      snapshot = snapshotNativeArtifact({ draftsDirectory: resolve(this.store.directory, 'drafts'), snapshotDirectory: resolve(this.store.directory, 'outputs'), path: args.path })
      const contentMimeType = this.validateSnapshot(snapshot.path, args.mediaTypeHint)
      if (!this.command.outputs.mimeTypes.includes(contentMimeType)) fail('NATIVE_OUTPUT_FORMAT_INVALID')
      const outputId = `output_${key.slice('native-call-'.length)}`
      const artifact = { outputId, displayName: args.displayName, contentMimeType, sha256: snapshot.sha256, byteLength: snapshot.byteLength }
      const captured = { ...started, phase: 'CAPTURED', temporaryName: basename(snapshot.path), artifact }
      this.store.write(key, captured)
      return this._publish(key, captured)
    } catch (error) {
      // Preserve CAPTURED journals for publication recovery. Only a capture or
      // format rejection owns an unpublished temporary file here.
      if (this.store.read(key)?.phase === 'STARTED') {
        if (snapshot) unlinkSync(snapshot.path)
        if (recoverableSource(error.code)) { this.store.write(key, { ...started, phase: 'FAILED', code: error.code }); fail(error.code, true) }
      }
      throw error
    }
  }
  _publish(key, captured) {
    const directory = resolve(this.store.directory, 'outputs'); const destination = resolve(directory, captured.artifact.outputId)
    if (!existsSync(destination)) renameSync(resolve(directory, captured.temporaryName), destination)
    syncDir(directory)
    this.store.verifyBlob(captured.artifact.outputId, captured.artifact)
    this.store.write(`artifact-${captured.artifact.outputId}`, captured.artifact)
    const reply = { artifactRef: captured.artifact.outputId, ...captured.artifact, state: 'SNAPSHOTTED' }
    this.store.write(key, { phase: 'DONE', requestSha256: captured.requestSha256, reply })
    return reply
  }
  _propose(key, requestSha256, args, binding) {
    if (Object.keys(args).sort().join(',') !== 'artifactRefs,data,summary' || typeof args.summary !== 'string'
        || !Array.isArray(args.artifactRefs) || !args.artifactRefs.every(skillId) || new Set(args.artifactRefs).size !== args.artifactRefs.length) fail('NATIVE_PROPOSAL_INVALID', true)
    const outputs = this.command.outputs
    if (outputs.artifactsRequired && !args.artifactRefs.length || !outputs.multiple && args.artifactRefs.length > 1) fail('NATIVE_PROPOSAL_INVALID', true)
    if (!outputs.dataSchema && args.data !== null) fail('NATIVE_PROPOSAL_INVALID', true)
    if (outputs.dataSchema) { try { validateSkillData(outputs.dataSchema, args.data) } catch { fail('NATIVE_PROPOSAL_INVALID', true) } }
    const artifacts = args.artifactRefs.map(ref => {
      const artifact = this.store.read(`artifact-${ref}`)
      if (!artifact || artifact.outputId !== ref || !outputs.mimeTypes.includes(artifact.contentMimeType)) fail('NATIVE_PROPOSAL_ARTIFACT_UNKNOWN', true)
      this.store.verifyBlob(ref, artifact); return artifact
    })
    const previous = this.store.read('native-selection')
    const proposal = { ...binding, revision: String(BigInt(previous?.revision || '0') + 1n), summary: args.summary, artifacts, data: args.data }
    const reply = { proposalId: key, proposalSha256: skillDigest(proposal), state: 'PENDING_FINALIZATION' }
    this.store.write(key, { phase: 'DONE', requestSha256, proposal, reply })
    this._select(proposal)
    return reply
  }
  _select(proposal) {
    const current = this.store.read('native-selection')
    if (!current || BigInt(current.revision) < BigInt(proposal.revision)) this.store.write('native-selection', proposal)
    else if (current.revision === proposal.revision && skillDigest(current) !== skillDigest(proposal)) fail('NATIVE_PROPOSAL_CONFLICT')
  }
  finalize(terminal, inputReceipts) {
    this.checkActive()
    const binding = this.store.read('native-turn'); let proposal = this.store.read('native-selection')
    if (!binding || terminal.finishReason !== 'completed' || terminal.threadId !== binding.threadId || terminal.turnId !== binding.turnId) fail('NATIVE_TERMINAL_UNCONFIRMED')
    if (!proposal && !this.command.outputs.artifactsRequired && !this.command.outputs.dataSchema) {
      proposal = { ...binding, revision: '0', summary: terminal.content || '', artifacts: [], data: null }
      this.store.write('native-selection', proposal)
    }
    if (!proposal) fail('NATIVE_PROPOSAL_REQUIRED')
    this.store.write('native-terminal', { ...binding, status: 'completed', proposalSha256: skillDigest(proposal) })
    return this.store.persistNativeResult({ data: proposal.data, artifacts: proposal.artifacts, inputReceipts, effectDependencies: [] })
  }
}
