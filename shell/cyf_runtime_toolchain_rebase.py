#!/usr/bin/env python3
"""Rebase only generated Python venv paths in a stopped, privately staged artifact.

No service control, package installation, state adoption or implicit overwrite.
The operator must hold deployment ownership and validate the complete artifact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


def plan(root, old_root):
    root, old_root = Path(root), Path(old_root)
    for value in (root, old_root):
        if not value.is_absolute() or str(value) != os.path.normpath(str(value)):
            raise ValueError('ROOT_MUST_BE_CANONICAL_ABSOLUTE')
    if root.resolve() != root or root.is_symlink() or not root.is_dir():
        raise ValueError('CANDIDATE_ROOT_UNSAFE')
    if root == old_root or old_root in root.parents or root in old_root.parents:
        raise ValueError('ROOTS_MUST_BE_DISTINCT_NON_NESTED')
    venv = root / 'codex-bridge/.toolchain'
    old_venv = str(old_root / 'codex-bridge/.toolchain')
    new_venv = str(venv)
    if venv.resolve() != venv or not venv.is_dir():
        raise ValueError('VENV_UNSAFE')
    # Existing installer already makes pip/console launchers relative. Do not
    # silently rewrite unknown launchers, binary contents or provenance files.
    allowed = {
        'pyvenv.cfg': b'command = ',
        'bin/activate': b'VIRTUAL_ENV=',
        'bin/activate.csh': b'setenv VIRTUAL_ENV ',
        'bin/activate.fish': b'set -gx VIRTUAL_ENV ',
    }
    changes = []
    prefix = str(old_root).encode()
    for directory, dirs, files in os.walk(str(root), followlinks=False):
        for name in dirs + files:
            p = Path(directory) / name
            s = p.lstat()
            if stat.S_ISLNK(s.st_mode):
                if prefix in os.readlink(str(p)).encode():
                    raise ValueError('OLD_ROOT_SYMLINK: ' + str(p.relative_to(root)))
                continue
            if not stat.S_ISREG(s.st_mode):
                if not stat.S_ISDIR(s.st_mode):
                    raise ValueError('SPECIAL_FILE: ' + str(p.relative_to(root)))
                continue
            # Scan without loading binary/toolchain files in memory.
            found = False
            with p.open('rb') as stream:
                tail = b''
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    if prefix in tail + chunk:
                        found = True
                        break
                    tail = chunk[-len(prefix):]
            if not found:
                continue
            rel = str(p.relative_to(venv)) if venv in p.parents else ''
            if rel not in allowed or s.st_nlink != 1 or s.st_uid != os.geteuid() or s.st_mode & 0o022:
                raise ValueError('UNEXPECTED_OR_UNSAFE_OLD_ROOT_REFERENCE: ' + str(p.relative_to(root)))
            before = p.read_bytes()
            lines = before.splitlines(keepends=True)
            hits = [i for i, line in enumerate(lines) if prefix in line]
            if len(hits) != 1 or not lines[hits[0]].startswith(allowed[rel]):
                raise ValueError('UNRECOGNIZED_GENERATED_PATH: ' + rel)
            line = lines[hits[0]]
            if line.count(old_venv.encode()) != 1 or line.count(prefix) != 1:
                raise ValueError('UNEXPECTED_GENERATED_PATH: ' + rel)
            lines[hits[0]] = line.replace(old_venv.encode(), new_venv.encode())
            after = b''.join(lines)
            if prefix in after:
                raise ValueError('STALE_ROOT: ' + rel)
            changes.append((p, before, after, s))
    return changes


def rebase(root, old_root, apply=False):
    changes = plan(root, old_root)
    report = []
    for p, before, after, s in changes:
        report.append({'path': str(p.relative_to(root)), 'beforeSha256': hashlib.sha256(before).hexdigest(),
                       'afterSha256': hashlib.sha256(after).hexdigest()})
        if apply:
            current = p.lstat()
            if (current.st_ino, current.st_dev, current.st_mtime_ns) != (s.st_ino, s.st_dev, s.st_mtime_ns) or p.read_bytes() != before:
                raise ValueError('CANDIDATE_CHANGED')
            fd, tmp = tempfile.mkstemp(prefix='.rebase-', dir=str(p.parent))
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(after)
                    os.fchmod(stream.fileno(), stat.S_IMODE(s.st_mode))
                    os.fchown(stream.fileno(), s.st_uid, s.st_gid)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp, str(p))
                directory = os.open(str(p.parent), os.O_DIRECTORY | os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
    return {'applied': apply, 'root': str(root), 'fromRoot': str(old_root), 'changes': report}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--from-root', required=True, type=Path)
    parser.add_argument('--apply', action='store_true', help='otherwise read-only; use only with stopped/exclusive artifact')
    args = parser.parse_args()
    print(json.dumps(rebase(args.root, args.from_root, args.apply), indent=2))
