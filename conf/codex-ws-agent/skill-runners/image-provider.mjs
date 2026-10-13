/** Trusted host broker: packages/model parameters never receive credentials or
 * choose an endpoint. All external generation goes through registered effects. */
import { responsePng } from './image-http-codec.mjs'
import { CONTROLLED_IMAGE_MAX_EDIT_IMAGE_URL_LENGTH } from '../controlled-image-v3-files.mjs'
import { skillDigest } from '../skill-executor.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const adapters = new Set(['image-http.generate', 'image-http.edit'])
export function createImageProviderRunner({ bindings, scope, fetchFn = globalThis.fetch }) {
  return {
    probe: async context => adapters.has(context.entrypoint) && typeof bindings?.resolve === 'function' && typeof fetchFn === 'function'
      ? { ready: true, digest: skillDigest({ adapter: 'image-http', codec: 1, entrypoint: context.entrypoint }) }
      : { ready: false, reasonCode: 'SKILL_PROVIDER_ADAPTER_MISSING' },
    run: async ({ command, descriptor, binding, inputs, instruction, parameters, effects }) => {
      if (!adapters.has(descriptor.manifest.entrypoint) || Object.keys(parameters).length !== 0 || !Array.isArray(inputs)
          || inputs.length > 16 || (descriptor.manifest.entrypoint === 'image-http.edit' && inputs.length !== 1)) fail('SKILL_IMAGE_REQUEST_INVALID')
      const current = await bindings.resolve({ scope, alias: descriptor.manifest.requirements.providerAlias })
      if (!current.ready || current.bindingId !== binding?.bindingId || current.revision !== binding.revision || current.digest !== binding.digest) fail('SKILL_PROVIDER_BINDING_CHANGED')
      const images = inputs.map(input => {
        if (!['image/png', 'image/jpeg'].includes(input.contentMimeType) || !Buffer.isBuffer(input.bytes)) fail('SKILL_IMAGE_INPUT_INVALID')
        const signature = input.contentMimeType === 'image/png' ? Buffer.from([137,80,78,71,13,10,26,10]) : Buffer.from([255,216,255])
        if (!input.bytes.subarray(0, signature.length).equals(signature)) fail('SKILL_IMAGE_INPUT_INVALID')
        const image_url = `data:${input.contentMimeType};base64,${input.bytes.toString('base64')}`
        if (image_url.length > CONTROLLED_IMAGE_MAX_EDIT_IMAGE_URL_LENGTH) fail('SKILL_IMAGE_INPUT_INVALID')
        return { image_url }
      })
      const path = inputs.length ? '/v1/images/edits' : '/v1/images/generations'
      const body = { model: current.model, prompt: instruction, ...(images.length ? { images } : {}), n: 1, output_format: 'png' }
      const request = { adapter: 'image-http', entrypoint: descriptor.manifest.entrypoint, instruction, parameters,
        inputs: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, contentMimeType: input.contentMimeType, byteLength: input.byteLength })),
        bindingId: current.bindingId, bindingDigest: current.digest, model: current.model, path }
      const produced = await effects.invoke('generate', request, async () => {
        const endpoint = new URL(path, `${current.endpoint}/`)
        // No application/model deadline. Keep actual fetch/TLS failures as causes.
        const response = await fetchFn(endpoint, { method: 'POST', redirect: 'error', headers: {
          Authorization: `Bearer ${current.credential}`, Accept: 'application/json', 'Content-Type': 'application/json'
        }, body: JSON.stringify(body) })
        const bytes = await responsePng(response, endpoint)
        return { bytes, providerRequestId: response.headers?.get?.('x-request-id') || null }
      })
      return { data: {}, artifacts: [{ outputId: 'output_1', contentMimeType: 'image/png', bytes: produced.bytes }],
        inputReceipts: inputs.map(input => ({ inputRef: input.inputRef, sha256: input.sha256, carrier: 'provider-image', delivery: 'DELIVERED' })) }
    }
  }
}
