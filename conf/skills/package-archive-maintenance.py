#!/usr/bin/env python3
"""Build one deterministic generic skill package. No book data, deployment or catalog writes."""
import hashlib, io, json, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent
skill = root / 'archive-maintenance-1.1.1'
entries = ('SKILL.md', 'manifest.json', 'scripts/build-archive.mjs')
stream = io.BytesIO()
with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(entries):
        entry = zipfile.ZipInfo(name, (2026, 10, 23, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, (skill / name).read_bytes())
content = stream.getvalue()
target = root / 'archive-maintenance-1.1.1.zip'
if target.exists() and target.read_bytes() != content:
    raise SystemExit('Refusing to replace different versioned package bytes; prepare a new skill version')
target.write_bytes(content)
receipt = dict(schemaVersion=1, skillKey='archive-maintenance', skillVersion='1.1.1', packageFile=target.name,
    packageSha256=hashlib.sha256(content).hexdigest(), packageByteLength=len(content),
    manifestSha256=hashlib.sha256((skill / 'manifest.json').read_bytes()).hexdigest(),
    state='PREPARED_NOT_PUBLISHED')
(root / 'archive-maintenance-1.1.1-package.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt))
