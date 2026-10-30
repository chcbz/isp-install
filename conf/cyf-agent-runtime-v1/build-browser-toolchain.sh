#!/bin/bash
# Flow worker only. Populate one new dependency stage; no installation/activation.
# Caller binds the archive and manifest to the fixed source Run using python-artifact.py.
set -euo pipefail
[ "$#" = 1 ] || { echo 'usage: build-browser-toolchain.sh NEW_STAGE' >&2; exit 2; }
STAGE="$1"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$STAGE" = /* ]] && [ "$(readlink -m "$STAGE")" = "$STAGE" ]
[ ! -e "$STAGE" ] && [ ! -L "$STAGE" ]
mkdir -m 700 "$STAGE"
cp "$SOURCE_DIR/../codex-bridge/toolchain/browser/"{package.json,package-lock.json,sources.json} "$STAGE/"
npm ci --prefix "$STAGE" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmmirror.com --fetch-retries=1 --fetch-timeout=60000
python3 -I -B - "$STAGE" <<'PY'
import hashlib, json, pathlib, subprocess, sys, zipfile
root = pathlib.Path(sys.argv[1])
sources = json.loads((root / 'sources.json').read_text())
def fetch(source, target):
    # Mirrors have the same pinned content. Never accept a successful download
    # with a different digest or retry a hash mismatch against another source.
    for url in ([source['mirror']] if 'mirror' in source else []) + [source['url']]:
        result = subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
            '--connect-timeout', '15', '--max-time', '120', '-H', 'Accept: application/vnd.github.raw+json',
            url, '-o', str(target)])
        if result.returncode == 0:
            digest = hashlib.sha256()
            with target.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
            if digest.hexdigest() != source['sha256']: raise ValueError('BROWSER_SOURCE_DIGEST_MISMATCH')
            return
    raise RuntimeError('BROWSER_SOURCE_DOWNLOAD_FAILED')
archive = root / 'chromium.zip'
fetch(sources['chromium'], archive)
# This is the fixed, digest-verified vendor archive, not arbitrary user content.
with zipfile.ZipFile(str(archive)) as stream:
    stream.extractall(str(root))
(root / 'chrome-headless-shell-linux64').rename(root / 'chromium')
(root / 'chromium/chrome-headless-shell').chmod(0o755)
archive.unlink()
fonts = root / 'fonts'
fonts.mkdir(mode=0o755)
for key in ['font', 'fontLicense']: fetch(sources[key], fonts / sources[key]['name'])
# Assert the SDK's browser version matches the pinned distribution.
browsers = json.loads((root / 'node_modules/playwright-core/browsers.json').read_text())['browsers']
expected = next(item for item in browsers if item['name'] == 'chromium-headless-shell')
assert expected['browserVersion'] == sources['chromium']['version'], 'BROWSER_SDK_VERSION_MISMATCH'
print('Fixed browser, SDK and licensed font stage prepared; not installed')
PY
