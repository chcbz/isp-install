import { parseManagementMessage } from './skill-management-wire.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const positionResult = e => e?.messageType === 'work.result' && e.data?.schemaVersion === 2
  && typeof e.data.skillChangeId === 'string' && e.data.skillChangeId.startsWith('ps_')

/** Position is a server-owned authorization source, not another installer.
 * Current management commands, durable results and actual server receipts share the normal journal. */
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
  async commitResult(envelope) {
    if (!this.current()) fail('POSITION_SESSION_CHANGED')
    const receipt = await this.json('/internal/agent/position-skills/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope)
    })
    if (!this.current()) fail('POSITION_SESSION_CHANGED')
    // handle verifies the real correlated receipt against its durable result; never synthesize an ACK.
    await this.manager.handle(receipt)
  }
  async run() {
    if (!this.current()) return { processed: 0 }
    for (const { envelope } of this.manager.pendingResults()) {
      if (positionResult(envelope)) await this.commitResult(envelope)
    }
    let processed = 0
    // One prepare/activate cycle per poll. Unknown results only yield a backend-authorized READ.
    for (let phase = 0; phase < 2; phase++) {
      if (!this.current()) fail('POSITION_SESSION_CHANGED')
      const commands = await this.json('/internal/agent/position-skills')
      if (!Array.isArray(commands)) fail('POSITION_WIRE_INVALID')
      if (!commands.length) break
      for (const input of commands) {
        const envelope = parseManagementMessage(input)
        if (envelope.messageType !== 'command.dispatch' || envelope.data.agentId !== this.agentId
            || !envelope.data.skillChangeId.startsWith('ps_')) fail('POSITION_COMMAND_INVALID')
        if (!this.current()) fail('POSITION_SESSION_CHANGED')
        this.changed('changing')
        try {
          const result = await this.manager.handle(envelope)
          if (!positionResult(result.resultEnvelope)) fail('POSITION_RESULT_UNPROVEN')
          await this.commitResult(result.resultEnvelope)
          processed++
        } finally { this.changed('changed') }
      }
    }
    return { processed }
  }
}
