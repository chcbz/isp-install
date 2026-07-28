import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const assertNoLegacyWorkspaceRemoteSchema = (raw, source = 'workspace-policies.json') => {
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`)
  }
  const policies = Array.isArray(parsed) ? parsed : Object.values(parsed || {})
  for (const [index, policy] of policies.entries()) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) continue
    const remote = policy.remote
    if (remote && typeof remote === 'object' && !Array.isArray(remote)
        && (Object.hasOwn(remote, 'name') || Object.hasOwn(remote, 'url'))) {
      const policyId = String(policy.policyId || Object.keys(parsed || {})[index] || `#${index + 1}`)
      throw new Error(
        `${source} policy ${policyId} uses removed remote{name,url} schema; migrate explicitly to trustedRemoteUrl and trustedRemoteRef before restart`
      )
    }
  }
  return { policies: policies.length }
}

export const checkWorkspacePolicyFile = file => {
  const path = resolve(String(file || 'workspace-policies.json'))
  if (!existsSync(path)) return { policies: 0, missing: true }
  return assertNoLegacyWorkspaceRemoteSchema(readFileSync(path, 'utf8'), path)
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    console.log(JSON.stringify(checkWorkspacePolicyFile(process.argv[2])))
  } catch (error) {
    console.error(`WORKSPACE_POLICY_MIGRATION_REQUIRED: ${error.message}`)
    process.exit(1)
  }
}
