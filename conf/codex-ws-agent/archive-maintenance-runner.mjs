import { createHash } from 'node:crypto'

import {
  APPROVED_ARCHIVE_PACKAGE_SHA256,
  ARCHIVE_NATIVE_UNCERTAINTY,
  ArchiveMaintenanceNativeClient,
  validateArchiveMaintenanceCommand
} from './archive-maintenance-native.mjs'

const terminalResult = result => result?.runState === 'COMPLETED' || result?.runState === 'FAILED'
const jsonCanonical = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : ''
  if (Array.isArray(value)) return `[${value.map(jsonCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jsonCanonical(value[key])}`).join(',')}}`
  return ''
}
const sameJson = (left, right) => jsonCanonical(left) === jsonCanonical(right)
const operationKey = (command, action) => `archive-${action}-${createHash('sha256').update(`${command.commandId}\0${command.runId}\0${command.executionEpoch}\0${action}`).digest('hex')}`
const blockOperationKey = (command, blockKey) => `archive-block-${createHash('sha256').update(`${command.commandId}\0${command.runId}\0${command.executionEpoch}\0${blockKey}`).digest('hex')}`
const compatibleDraft = (content, target) => {
  if (!content || !target || !Array.isArray(content.blocks) || !Array.isArray(target.blocks)
    || !Array.isArray(content.excludedSourceRanges) || !Array.isArray(target.excludedSourceRanges)) return false
  const targetByKey = new Map()
  for (const block of target.blocks) {
    if (!block || typeof block.blockKey !== 'string' || targetByKey.has(block.blockKey)) return false
    targetByKey.set(block.blockKey, block)
  }
  const seen = new Set()
  for (const block of content.blocks) {
    if (!block || typeof block.blockKey !== 'string' || seen.has(block.blockKey)
      || !targetByKey.has(block.blockKey) || !sameJson(block, targetByKey.get(block.blockKey))) return false
    seen.add(block.blockKey)
  }
  const initialEmptyExclusions = content.blocks.length === 0 && content.excludedSourceRanges.length === 0
  return initialEmptyExclusions || sameJson(content.excludedSourceRanges, target.excludedSourceRanges)
}
const exactBlockCommitted = (content, target, blockKey) => compatibleDraft(content, target)
  && content.blocks.some(block => block.blockKey === blockKey && sameJson(block,
    target.blocks.find(candidate => candidate.blockKey === blockKey)))

const safeFailureCode = code => {
  const normalized = String(code || 'RUNNER_REJECTED').toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return (`ARCHIVE_${normalized}`).slice(0, 64)
}
const asOutcome = result => result.runState === 'COMPLETED'
  ? { status: 'completed', exitCode: 0, errorMessage: '', authoritative: true, result }
  : { status: 'failed', exitCode: null, errorMessage: result.failureCode || 'ARCHIVE_EXECUTION_FAILED', authoritative: true, result }
const recovery = error => ({ status: 'recovery_required', exitCode: null,
  errorMessage: `ARCHIVE_RECOVERY_REQUIRED: ${error?.code || 'ARCHIVE_OUTCOME_UNKNOWN'}`, authoritative: false })
const requestOutcomeUnknown = error => error?.uncertainty === ARCHIVE_NATIVE_UNCERTAINTY.REQUEST_OUTCOME_UNKNOWN

const loadApprovedDiagnoser = async installation => {
  const parseBytes = installation.files.get('scripts/parse-text.mjs')
  const checkBytes = installation.files.get('scripts/check-content.mjs')
  if (!parseBytes || !checkBytes) throw new Error('approved parser resources are unavailable')
  const parseUrl = `data:text/javascript;base64,${parseBytes.toString('base64')}`
  const source = checkBytes.toString('utf8')
  const expectedImport = "from './parse-text.mjs'"
  if (source.split(expectedImport).length !== 2) throw new Error('approved checker import contract changed')
  const checkSource = source.replace(expectedImport, `from '${parseUrl}'`)
  const module = await import(`data:text/javascript;base64,${Buffer.from(checkSource).toString('base64')}`)
  if (typeof module.diagnoseBytes !== 'function') throw new Error('approved checker export is unavailable')
  return module.diagnoseBytes
}

export class ArchiveMaintenanceRunner {
  constructor({ runtimeScope, wsUrl, authorizationProvider, platformSkillManager, fetchFn = globalThis.fetch,
    now = () => Date.now(), maxCallMs = 30000, sessionSignal = null, nativeClientFactory = options => new ArchiveMaintenanceNativeClient(options) }) {
    this.runtimeScope = Object.freeze({ ...runtimeScope })
    this.now = now
    this.sessionSignal = sessionSignal
    this.manager = platformSkillManager
    this.client = nativeClientFactory({ wsUrl, runtimeScope, authorizationProvider, fetchFn, now, maxCallMs, sessionSignal })
    this.terminal = new Map()
    this.inFlight = new Map()
  }

  _command(message, allowExpired = false) { return validateArchiveMaintenanceCommand(message, this.runtimeScope, this.now(), { allowExpired }) }
  _fingerprint(command) { return createHash('sha256').update(jsonCanonical(command)).digest('hex') }
  _cache(command, outcome) { this.terminal.set(command.commandId, Object.freeze({ fingerprint: this._fingerprint(command), outcome: Object.freeze(outcome) })); return outcome }
  _assertLive() { if (this.sessionSignal?.aborted) throw this.sessionSignal.reason || new Error('archive runtime registration rotated') }

  reconcileCommandOutcome(message) {
    try {
      this._assertLive()
      const command = this._command(message, true)
      const cached = this.terminal.get(command.commandId)
      return cached?.fingerprint === this._fingerprint(command) ? cached.outcome : null
    } catch { return null }
  }

  async recover(messages = []) {
    const outcomes = []
    for (const message of messages) {
      this._assertLive()
      outcomes.push(await this.execute(message))
      await new Promise(resolvePromise => setImmediate(resolvePromise))
    }
    return outcomes
  }

  async execute(message) {
    let command
    try { this._assertLive(); command = this._command(message, true) } catch (error) { return recovery(error) }
    const fingerprint = this._fingerprint(command)
    const cached = this.terminal.get(command.commandId)
    if (cached) return cached.fingerprint === fingerprint ? cached.outcome : recovery({ code: 'ARCHIVE_COMMAND_CONFLICT' })
    const active = this.inFlight.get(command.commandId)
    if (active) return active.fingerprint === fingerprint ? active.promise : recovery({ code: 'ARCHIVE_COMMAND_CONFLICT' })
    const promise = this._execute(command).catch(recovery)
    this.inFlight.set(command.commandId, { fingerprint, promise })
    try { return await promise } finally { if (this.inFlight.get(command.commandId)?.promise === promise) this.inFlight.delete(command.commandId) }
  }

  async _terminal(command) {
    const result = await this.client.result(command)
    return terminalResult(result) ? this._cache(command, asOutcome(result)) : null
  }

  async _recordSafeFailure(command, phase, code) {
    this._assertLive()
    if (this.now() >= command.expiresAt) return recovery({ code: 'ARCHIVE_EXECUTION_EXPIRED' })
    try {
      const result = await this.client.failure(command, { phase, code: safeFailureCode(code), retryable: false })
      return terminalResult(result) ? this._cache(command, asOutcome(result)) : recovery({ code: 'ARCHIVE_FAILURE_RECEIPT_UNKNOWN' })
    } catch (error) {
      try { return await this._terminal(command) || recovery(error) } catch { return recovery(error) }
    }
  }

  async _execute(command) {
    this._assertLive()
    try {
      const terminal = await this._terminal(command)
      if (terminal) return terminal
    } catch (error) {
      if (this.now() >= command.expiresAt) return recovery(error)
      // Before the producer deadline, a missing initial receipt does not authorize
      // treating the command as new; the exact start call remains the server gate.
    }
    if (this.now() >= command.expiresAt) return recovery({ code: 'ARCHIVE_EXECUTION_EXPIRED' })

    try {
      const started = await this.client.start(command)
      if (terminalResult(started)) return this._cache(command, asOutcome(started))
      if (started.runState !== 'RUNNING' || started.jobState !== 'RUNNING' || started.stage !== 'RUNNING') {
        return recovery({ code: 'ARCHIVE_START_NOT_RUNNING' })
      }
    } catch (error) {
      try {
        const result = await this.client.result(command)
        if (terminalResult(result)) return this._cache(command, asOutcome(result))
        if (result.runState !== 'RUNNING' || result.jobState !== 'RUNNING' || result.stage !== 'RUNNING') return recovery(error)
      } catch { return recovery(error) }
    }
    this._assertLive()

    let context
    try { context = await this.client.context(command) } catch (error) { return recovery(error) }
    if (!['RUNNING', 'AWAITING_PUBLISH'].includes(context.state) || context.requiredSkill.packageSha256 !== APPROVED_ARCHIVE_PACKAGE_SHA256) {
      return recovery({ code: 'ARCHIVE_CONTEXT_CHANGED' })
    }
    let installation
    try { installation = this.manager.resolveApprovedArchiveInstallation(command.skillInstallationId) } catch (error) { return recovery(error) }
    if (!installation || installation.packageSha256 !== command.skillPackageSha256) return recovery({ code: 'ARCHIVE_SKILL_NOT_INSTALLED' })

    let source
    try { source = await this.client.source(command, context) } catch (error) { return recovery(error) }
    if (createHash('sha256').update(source).digest('hex') !== context.sourceSha256) return recovery({ code: 'ARCHIVE_SOURCE_DIGEST_MISMATCH' })

    let diagnosis
    try {
      this.manager.reverifyApprovedArchiveInstallation(installation)
      const diagnoseBytes = await loadApprovedDiagnoser(installation)
      diagnosis = diagnoseBytes(new Uint8Array(source))
      this.manager.reverifyApprovedArchiveInstallation(installation)
    } catch (error) { return recovery({ code: error?.code || 'ARCHIVE_PACKAGE_PROOF_CHANGED' }) }
    if (!diagnosis?.ok) return this._recordSafeFailure(command, 'RUNNER', diagnosis?.code || 'LOCAL_PARSE_FAILED')
    if (diagnosis.sourceSha256 !== context.sourceSha256) return recovery({ code: 'ARCHIVE_SOURCE_DIGEST_MISMATCH' })

    let draft
    try { draft = await this.client.draft(command) } catch (error) { return recovery(error) }
    if (draft.draftId !== context.draftId || draft.revision !== context.draftRevision) {
      return recovery({ code: 'ARCHIVE_DRAFT_SNAPSHOT_CHANGED' })
    }
    if (!sameJson(draft.content, diagnosis.draft)) {
      if (!compatibleDraft(draft.content, diagnosis.draft)) return recovery({ code: 'ARCHIVE_DRAFT_CONFLICT' })
      for (const block of diagnosis.draft.blocks) {
        if (draft.content.blocks.some(existing => existing.blockKey === block.blockKey
          && sameJson(existing, block))) continue
        const body = { blocks: [block], excludedSourceRanges: diagnosis.draft.excludedSourceRanges }
        try {
          draft = await this.client.putBlock(command, block.blockKey, draft.revision,
            blockOperationKey(command, block.blockKey), body)
          if (draft.draftId !== context.draftId || !exactBlockCommitted(
            draft.content, diagnosis.draft, block.blockKey)) {
            return recovery({ code: 'ARCHIVE_DRAFT_COMMIT_MISMATCH' })
          }
        } catch (error) {
          try {
            draft = await this.client.draft(command)
            if (draft.draftId !== context.draftId || !exactBlockCommitted(
              draft.content, diagnosis.draft, block.blockKey)) return recovery(error)
          } catch { return recovery(error) }
        }
      }
      if (!sameJson(draft.content, diagnosis.draft)) {
        return recovery({ code: 'ARCHIVE_DRAFT_COMMIT_MISMATCH' })
      }
    }
    this._assertLive()

    let validation
    if (draft.validationId && draft.validatedRevision === draft.revision) {
      try { validation = await this.client.validation(command, draft.validationId) } catch (error) { return recovery(error) }
    } else {
      const validateKey = operationKey(command, 'validate')
      try {
        validation = await this.client.validate(command, draft.draftId, draft.revision, validateKey)
      } catch (error) {
        if (error?.operationId && requestOutcomeUnknown(error)) {
          try { validation = await this.client.validation(command, error.operationId) } catch { return recovery(error) }
        } else if (!error?.operationId && requestOutcomeUnknown(error)) {
          try { validation = await this.client.validation(command) } catch { return recovery(error) }
        } else return recovery(error)
      }
    }
    if (validation.draftId !== draft.draftId || validation.draftRevision !== draft.revision) return recovery({ code: 'ARCHIVE_VALIDATION_CHANGED' })
    if (validation.outcome !== 'PASSED') return this._recordSafeFailure(command, 'VALIDATION', 'SERVER_VALIDATION_FAILED')

    const eligibleAuto = context.publicationMode === 'AUTO' && context.permissionProfile === 'PUBLISH_VALIDATED'
    if (eligibleAuto) {
      const publishCommand = { ...command, sourceSha256: context.sourceSha256 }
      const body = { validationId: validation.validationId, expectedActiveEditionId: context.expectedActiveEditionId,
        expectedWorkRevision: context.expectedWorkRevision }
      try {
        await this.client.publish(publishCommand, draft.revision, operationKey(command, 'publish'), body)
      } catch (error) {
        try {
          const terminal = await this._terminal(command)
          if (terminal) return terminal
          if (!requestOutcomeUnknown(error)) return recovery(error)
          await this.client.publish(publishCommand, draft.revision, operationKey(command, 'publish'), body)
        } catch { return recovery(error) }
      }
    }

    try {
      const terminal = await this._terminal(command)
      return terminal || recovery({ code: 'ARCHIVE_TERMINAL_RECEIPT_PENDING' })
    } catch (error) { return recovery(error) }
  }
}
