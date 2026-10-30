#!/usr/bin/env python3
"""Fixed-Run Python toolchain archive; no builds, services or business state.

Pack runs on the Flow worker. Extract runs in a new host installation stage.
The enclosing release metadata binds the manifest to the source Run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile


def sha(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def inventory(root):
    root = Path(root)
    entries = []
    def walk(directory):
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            entry = {'path': path.relative_to(root).as_posix(), 'mode': stat.S_IMODE(info.st_mode)}
            if path.is_symlink():
                target = os.readlink(str(path))
                if os.path.isabs(target) or not str(path.resolve()).startswith(str(root.resolve()) + os.sep):
                    raise ValueError('PYTHON_ARTIFACT_LINK_OUTSIDE')
                entry.update(type='symlink', target=target)
            elif path.is_dir():
                entry.update(type='directory')
            elif path.is_file():
                entry.update(type='file', sha256=sha(path))
            else:
                raise ValueError('PYTHON_ARTIFACT_SPECIAL_FILE')
            entries.append(entry)
            if entry['type'] == 'directory':
                walk(path)
    walk(root)
    return sorted(entries, key=lambda entry: entry['path'])


def pack(root, archive, manifest):
    root, archive, manifest = Path(root), Path(archive), Path(manifest)
    if root.resolve() != root or not root.is_dir() or archive.exists() or manifest.exists():
        raise ValueError('PYTHON_ARTIFACT_NEW_PATHS_REQUIRED')
    if root in archive.resolve().parents or root in manifest.resolve().parents:
        raise ValueError('PYTHON_ARTIFACT_OUTPUT_INSIDE_SOURCE')
    entries = inventory(root)
    with tarfile.open(str(archive), 'x:gz', dereference=False) as stream:
        for entry in entries:
            stream.add(str(root / entry['path']), arcname=entry['path'], recursive=False)
    # Reject a changing build tree; don't attest a different snapshot.
    if entries != inventory(root):
        raise ValueError('PYTHON_ARTIFACT_SOURCE_CHANGED')
    manifest.write_text(json.dumps({'schemaVersion': 1, 'sha256': sha(archive), 'entries': entries}, indent=2) + '\n')


def extract(archive, manifest, target):
    archive, manifest, target = Path(archive), Path(manifest), Path(target)
    if target.exists() or target.is_symlink() or target.parent.resolve() != target.parent:
        raise ValueError('PYTHON_ARTIFACT_NEW_TARGET_REQUIRED')
    expected = json.loads(manifest.read_text())
    if expected.get('schemaVersion') != 1 or sha(archive) != expected['sha256']:
        raise ValueError('PYTHON_ARTIFACT_DIGEST_MISMATCH')
    rows = expected['entries']
    entries = {entry['path']: entry for entry in rows}
    if len(entries) != len(rows):
        raise ValueError('PYTHON_ARTIFACT_DUPLICATE_ENTRY')
    with tarfile.open(str(archive), 'r:gz') as stream:
        members = stream.getmembers()
        if len(members) != len(entries) or {member.name for member in members} != set(entries):
            raise ValueError('PYTHON_ARTIFACT_MEMBER_MISMATCH')
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or str(path) != member.name or member.name == '.':
                raise ValueError('PYTHON_ARTIFACT_UNSAFE_PATH')
            entry = entries[member.name]
            if member.mode != entry['mode'] or member.mode & 0o6022:
                # Symlink mode is normally 0777; it is never chmod'ed/followed.
                if not (member.issym() and entry['type'] == 'symlink' and member.mode == entry['mode']):
                    raise ValueError('PYTHON_ARTIFACT_UNSAFE_MODE')
            for parent in path.parents:
                if str(parent) != '.' and entries.get(str(parent), {}).get('type') != 'directory':
                    raise ValueError('PYTHON_ARTIFACT_NON_DIRECTORY_PARENT')
            if member.issym():
                link = os.path.normpath(str(path.parent / member.linkname))
                if entry['type'] != 'symlink' or member.linkname != entry['target'] or os.path.isabs(member.linkname) or link == '..' or link.startswith('../'):
                    raise ValueError('PYTHON_ARTIFACT_UNSAFE_LINK')
            elif not ((member.isdir() and entry['type'] == 'directory') or (member.isfile() and entry['type'] == 'file')):
                raise ValueError('PYTHON_ARTIFACT_UNSAFE_TYPE')
        target.mkdir(mode=0o700)
        # Parents first, regular contents next, symlinks last: never write via a link.
        for member in sorted(members, key=lambda item: (0 if item.isdir() else 2 if item.issym() else 1, len(PurePosixPath(item.name).parts), item.name)):
            path = target / member.name
            if member.isdir():
                path.mkdir(mode=0o700)
            elif member.issym():
                path.symlink_to(member.linkname)
            else:
                with stream.extractfile(member) as source, path.open('xb') as output:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        output.write(block)
                path.chmod(member.mode)
        for member in members:
            if member.isdir():
                (target / member.name).chmod(member.mode)
    if inventory(target) != sorted(rows, key=lambda entry: entry['path']):
        raise ValueError('PYTHON_ARTIFACT_EXTRACTED_CONTENT_MISMATCH')
    return expected['sha256']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['pack', 'extract'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    if args.action == 'pack':
        pack(args.root, args.archive, args.manifest)
    else:
        print(extract(args.archive, args.manifest, args.root))
