/** Public website routing, independent of per-installation credential configuration.
 * Resolve once and connect to the checked address: never re-resolve after checking.
 * Special-use ranges follow IANA's IPv4/IPv6 special-purpose registries; the
 * conservative IPv6 policy excludes transition ranges that can embed private IPv4.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
const deniedV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['168.63.129.16', 32], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) deniedV4.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
const deniedV6 = new BlockList()
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) deniedV6.addSubnet(address, prefix, 'ipv6')
export function isPublicWebAddress(address) {
  const family = isIP(address)
  if (family === 4) return !deniedV4.check(address, 'ipv4')
  return family === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6')
}
const deny = () => { throw Object.assign(new Error('PUBLIC_WEB_DESTINATION_DENIED'), { code: 'PUBLIC_WEB_DESTINATION_DENIED' }) }
export async function resolvePublicWebDestination(hostname, { lookupFn = lookup, timeoutMs } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) deny()
  const host = hostname.replace(/^\[|\]$/g, '')
  if (!host || host.includes('%')) deny()
  const family = isIP(host)
  let addresses, timer
  try {
    addresses = family ? [{ address: host, family }] : await Promise.race([
      lookupFn(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('PUBLIC_WEB_DNS_TIMEOUT'), { code: 'PUBLIC_WEB_DNS_TIMEOUT' })), timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
  if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address) || isIP(item.address) !== item.family)) deny()
  // Prefer IPv4 when available; do not assume this host has an IPv6 route.
  return addresses.find(item => item.family === 4) || addresses[0]
}
