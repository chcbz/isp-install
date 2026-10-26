import { skillDigest } from '../skill-executor.mjs'
import { validateNativeConversationOutput } from '../conversation-native.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const entries = new Set(['native-model.text-file', 'native-model.data'])
export const NATIVE_TEXT_FILE_RESULT_SCHEMA = Object.freeze({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false })
/** Existing native model machinery is injected by the host; there is no shell
 * runner or raw provider credential in the skill package. Actual model output is
 * converted to UTF-8 bytes by the host, not a summary/placeholder of the request. */
export function createNativeModelRunner({ probeModel, runModel }) {
  return {
    probe: async context => {
      if (!entries.has(context.entrypoint) || typeof runModel !== 'function' || typeof probeModel !== 'function') return { ready: false, reasonCode: 'SKILL_NATIVE_ADAPTER_MISSING' }
      const measured = await probeModel(context)
      if ((context.inputMimeTypes || []).some(mime => !['text/plain', 'text/markdown', 'application/json'].includes(mime) && !measured?.supportedMimeTypes?.includes(mime))) return { ready: false, reasonCode: 'MATERIALS_CARRIER_UNAVAILABLE' }
      return measured?.ready === true ? { ready: true, digest: skillDigest({ adapter: context.entrypoint, measurement: measured.digest }) }
        : { ready: false, reasonCode: 'SKILL_NATIVE_MODEL_UNAVAILABLE' }
    },
    run: async ({ command, descriptor, inputs, instruction, parameters, effects, outputDirectory }) => {
      const entrypoint = descriptor.manifest.entrypoint
      if (!entries.has(entrypoint)) fail('SKILL_NATIVE_ADAPTER_MISSING')
      const outputSchema = entrypoint === 'native-model.text-file' ? NATIVE_TEXT_FILE_RESULT_SCHEMA : descriptor.manifest.outputs.dataSchema
      if (!outputSchema) fail('SKILL_NATIVE_OUTPUT_SCHEMA_REQUIRED')
      const result = await effects.invoke('native-model', { entrypoint, instruction, parameters,
        inputs: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, contentMimeType: input.contentMimeType })), outputSchema },
      () => runModel({ command, inputs, instruction, parameters, outputSchema, outputDirectory }))
      if (entrypoint === 'native-model.data') return { data: result.data, artifacts: [], inputReceipts: result.inputReceipts }
      if (typeof result.data?.text !== 'string') fail('SKILL_NATIVE_TEXT_RESULT_INVALID')
      const bytes = Buffer.from(result.data.text, 'utf8')
      if (!validateNativeConversationOutput('text/plain', bytes)) fail('SKILL_NATIVE_TEXT_RESULT_INVALID')
      return { data: null, artifacts: [{ outputId: 'output_1', contentMimeType: 'text/plain', bytes }], inputReceipts: result.inputReceipts }
    }
  }
}
