// Historical test observations only; never imported by runtime code.
export const CODEX_APP_SERVER_SCHEMA = Object.freeze({ cliVersion: '0.153.4', bundleSha256: 'b06f77062369d481a59cc70720c12b89cb9dd49c385863923262102d3ad6c978' })
export const DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID = 'codex-cli-0.153.4'
export const CODEX_APP_SERVER_SCHEMA_CONTRACTS = Object.freeze({
  'codex-cli-0.161.0': Object.freeze({
    contractId: 'codex-cli-0.161.0',
    cliVersion: '0.161.0',
    bundleSha256: 'e7eb93e544b11833bd4ac39d14ec6ef26791b5b1ea43db0e451d772d6d27067a'
  }),
  [DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID]: Object.freeze({
    contractId: DEFAULT_CODEX_APP_SERVER_SCHEMA_CONTRACT_ID,
    ...CODEX_APP_SERVER_SCHEMA
  }),
  'codex-cli-0.160.0': Object.freeze({
    contractId: 'codex-cli-0.160.0',
    cliVersion: '0.160.0',
    bundleSha256: '7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5'
  }),
  'codex-cli-0.159.2': Object.freeze({
    contractId: 'codex-cli-0.159.2',
    cliVersion: '0.159.2',
    bundleSha256: '7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5'
  })
})

