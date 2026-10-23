import { randomUUID } from 'node:crypto'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
const revision = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n

/** Native desired-state adapter; all filesystem work goes through the existing durable SkillInstallManager.
 * A failed/ambiguous POST remains recoverable by the same grant revision and real durable install evidence. */
export class PositionSkillReconciler {
  constructor({ manager, nativeFetch, apiOrigin, agentId, current = () => true, changed = () => {} }) {
    this.manager = manager; this.fetch = nativeFetch; this.origin = new URL(apiOrigin).origin
    this.agentId = agentId; this.current = current; this.changed = changed; this.inFlight = null
  }
  poll() {
    if (!this.inFlight) this.inFlight = this.run().finally(() => { this.inFlight = null })
    return this.inFlight
  }
  async json(path, options = {}) {
    const response = await this.fetch(new URL(path, this.origin), options)
    if (!response.ok) throw Object.assign(new Error('POSITION_NATIVE_REJECTED'), { code: 'POSITION_NATIVE_REJECTED', status: response.status })
    const wire = await response.json()
    if (wire?.protocolVersion !== 1 || wire.code !== 'E0' || typeof wire.requestId !== 'string'
        || !Object.hasOwn(wire, 'data')) fail('POSITION_WIRE_INVALID')
    return wire.data
  }
  acknowledge(envelope) {
    this.manager.acknowledgeResultReceipt({ schemaVersion: 1, messageType: 'work.result.receipt', resultType: 'SKILL_INSTALL_RESULT',
      messageId: randomUUID(), correlationId: envelope.messageId, receiptStatus: 'ACCEPTED', commandId: envelope.commandId,
      installationId: envelope.installationId, targetAgentId: this.agentId, attempt: envelope.attempt,
      fencingToken: envelope.fencingToken, deliveryEpoch: envelope.deliveryEpoch })
  }
  async recoverReceipts() {
    for(const record of this.manager.pendingResults()) {
      const e=record.envelope
      if(!e.grantId)continue
      let r
      try { r=await this.json(`/internal/agent/position-skills/${e.grantId}/receipt`) }
      catch(error) { if(error.status===404)continue;throw error }
      if(r.grantId===e.grantId && r.revision===e.fencingToken && r.physicalInstallationId===e.installationId
          && r.state===(e.status==='SUCCEEDED'?'INSTALLED':'FAILED') && r.packageDigest===e.packageDigest
          && (r.manifestSha256??null)===(e.manifestSha256??null) && (r.errorCode??null)===(e.failureCode??null))this.acknowledge(e)
    }
  }
  async run() {
    if (!this.current()) return { processed: 0 }
    await this.recoverReceipts()
    const rows = await this.json('/internal/agent/position-skills')
    if (!Array.isArray(rows)) fail('POSITION_WIRE_INVALID')
    let processed = 0
    for (const row of rows) {
      if (!id(row?.grantId) || !revision(row.revision) || row.targetAgentId !== this.agentId
          || typeof row.desired !== 'boolean') fail('POSITION_COMMAND_INVALID')
      if (!this.current()) fail('POSITION_SESSION_CHANGED')
      this.changed('changing')
      let envelope = null
      let receipt = { grantId: row.grantId, revision: row.revision,
        physicalInstallationId: `${row.grantId}-${row.revision}`, installed: false,
        packageDigest: null, manifestSha256: null, errorCode: null }
      try {
        if (row.desired) {
          if (row.commandType !== 'SKILL_GRANT_INSTALL') fail('POSITION_COMMAND_INVALID')
          // A desired state can skip an intermediate removal while this host was offline.
          // Retire only older generations, never the current retry or a newer installation.
          this.manager.removeGranted(row.grantId, row.revision, { keepCurrent: true })
          const result = await this.manager.execute(row)
          envelope = result.resultEnvelope
          if (!envelope || envelope.grantId !== row.grantId || envelope.fencingToken !== row.revision
              || envelope.installationId !== receipt.physicalInstallationId) fail('POSITION_RESULT_UNPROVEN')
          receipt = { ...receipt, installed: envelope.status === 'SUCCEEDED', packageDigest: envelope.packageDigest,
            manifestSha256: envelope.manifestSha256 ?? null, errorCode: envelope.failureCode ?? null }
        } else this.manager.removeGranted(row.grantId, row.revision)
        if (!this.current()) fail('POSITION_SESSION_CHANGED')
        const accepted = await this.json(`/internal/agent/position-skills/${row.grantId}/receipt`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt)
        })
        const expected = receipt.errorCode ? 'FAILED' : receipt.installed ? 'INSTALLED' : 'REMOVED'
        if (accepted?.grantId !== row.grantId || accepted.revision !== row.revision || accepted.state !== expected) fail('POSITION_RECEIPT_INVALID')
        if (envelope) {
          this.acknowledge(envelope)
        }
        processed++
      } finally { this.changed('changed') }
    }
    return { processed }
  }
}
