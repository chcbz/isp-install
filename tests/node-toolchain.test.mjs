import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const text = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
test('host default and developer baseline use one fixed Node release', () => {
  const version = text('.node-version').trim()
  assert.equal(version, '24.22.1')
  const install = text('shell/node_install.sh')
  assert.ok(install.includes(`NODE_VERSION="\${NODE_VERSION:-v${version}}"`))
  assert.ok(install.includes('INSTALL_PREFIX="$ISP_APPS/node"'))
  assert.ok(install.includes('NODE_HOME=/home/isp/apps/node'))
  assert.equal(install.includes('dist/index.json'), false)
})
test('host installer verifies bytes and refuses silent adoption before extraction', () => {
  const install = text('shell/node_install.sh')
  assert.ok(install.includes('6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'))
  assert.ok(install.indexOf('[ ! -e "$INSTALL_PREFIX" ]') < install.indexOf('tar --no-same-owner'))
  assert.ok(install.indexOf('sha256sum -c -') < install.indexOf('tar --no-same-owner'))
  assert.ok(install.includes('curl --fail --silent --show-error --location'))
})
