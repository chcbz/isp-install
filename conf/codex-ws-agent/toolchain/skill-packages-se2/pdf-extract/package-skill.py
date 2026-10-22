#!/usr/bin/env python3
"""After npm ci --ignore-scripts --omit=optional, stage a dependency-locked local-script ZIP.
This packages the Agent skill only, never the API/Web production artifact.
"""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

root = Path(__file__).resolve().parent
stage = root / 'package'
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir()
for name in ('main.mjs', 'SKILL.md', 'manifest.json'):
    shutil.copyfile(root / name, stage / name)
vendor = stage / 'vendor'
vendor.mkdir()
pdf = root / 'node_modules/pdfjs-dist'
assert json.loads((pdf / 'package.json').read_text())['version'] == '6.4.299'
dom = root / 'node_modules/@thednp/dommatrix'
assert json.loads((dom / 'package.json').read_text())['version'] == '3.1.2'
for name in ('pdf.mjs', 'pdf.worker.mjs'):
    shutil.copyfile(pdf / 'legacy/build' / name, vendor / name)
for directory in ('cmaps', 'standard_fonts'):
    shutil.copytree(pdf / directory, vendor / directory)
shutil.copyfile(pdf / 'LICENSE', vendor / 'PDFJS-LICENSE')
shutil.copyfile(dom / 'LICENSE', vendor / 'DOMMATRIX-LICENSE')
shutil.copyfile(dom / 'dist/dommatrix.mjs', vendor / 'dommatrix.mjs')
files = sorted(p for p in stage.rglob('*') if p.is_file())
assert len(files) <= 256
assert sum(p.stat().st_size for p in files) <= 64 * 1024 * 1024
archive = root.parent / 'pdf-extract-1.0.0.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in files:
        entry = zipfile.ZipInfo(path.relative_to(stage).as_posix(), (2026, 10, 22, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(entry, path.read_bytes())
assert archive.stat().st_size <= 16 * 1024 * 1024
receipt = {'schemaVersion': 1, 'skillKey': 'pdf-extract', 'skillVersion': '1.0.0',
           'packageFile': archive.name, 'packageSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
           'packageByteLength': archive.stat().st_size, 'entries': len(files),
           'manifestSha256': hashlib.sha256((stage / 'manifest.json').read_bytes()).hexdigest(),
           'dependencyLockSha256': hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest(),
           'state': 'PREPARED_NOT_PUBLISHED'}
(root / 'release-input.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
