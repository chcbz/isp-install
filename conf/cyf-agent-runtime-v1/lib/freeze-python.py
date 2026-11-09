"""Make a privately staged venv independent of its build-host base Python.

Build-worker operation only: no download, compilation, service or state changes.
The enclosing artifact manifest binds every copied file; runtime still measures
ELF dependencies on the target and executes the actual isolated document probe.
"""
import json
import hashlib
import tempfile
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import sysconfig


def copy_standard_library(source, target):
    """Retain installed distributions; never copy the base's site-packages."""
    source, target = Path(source), Path(target)
    target.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source.iterdir()):
        if entry.name in ('site-packages', '__pycache__') or entry.suffix in ('.pyc', '.pyo'):
            continue
        destination = target / entry.name
        if destination.exists() or destination.is_symlink():
            raise ValueError('PYTHON_BASE_DESTINATION_EXISTS: ' + entry.name)
        if entry.is_dir():
            shutil.copytree(str(entry), str(destination), ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo'))
        else:
            shutil.copy2(str(entry), str(destination))


def protect_staged_permissions(prefix):
    """Remove upstream group/world writes before attesting the private stage.

    Standalone Python ships 0664/0775 files. Preserve read/execute bits and
    internal links; never chmod through a link or modify the build-host base.
    """
    for directory, directories, files in os.walk(str(prefix), followlinks=False):
        for path in [Path(directory)] + [Path(directory) / name for name in files]:
            info = path.lstat()
            if not stat.S_ISLNK(info.st_mode):
                path.chmod(stat.S_IMODE(info.st_mode) & ~0o6022)


def private_stage_location(prefix):
    prefix = Path(prefix)
    if str(prefix).startswith('/home/isp/baks/'):
        return False
    if not str(prefix).startswith('/home/isp/apps/'):
        return True
    # Existing installer mktemp stage, not an installed program or old release.
    return (prefix.name == '.toolchain' and prefix.parent.name == 'codex-bridge' and
            prefix.parents[1].name.startswith('.cyf-agent-runtime.stage.'))


def slim_staged_python(prefix, symbols=None):
    """Only a private pre-manifest stage: no package removal or sandbox edits.

    Byte-identical interpreter/library aliases share an inode. Debug stripping
    requires an explicit NEW disk output outside the whole Runtime stage; the
    symbol files and their original/output digests remain outside the artifact.
    Call before prepare-toolchain-image, which attests the final ELF bytes.
    """
    prefix = Path(prefix)
    if not prefix.is_absolute() or prefix.resolve() != prefix:
        raise ValueError('PYTHON_SLIM_STAGE_NOT_CANONICAL')
    if not private_stage_location(prefix):
        raise ValueError('PYTHON_SLIM_REFUSES_INSTALLED_PROGRAM')
    if subprocess.check_output(['stat', '-f', '-c', '%T', str(prefix)]).decode().strip() in ('tmpfs', 'ramfs'):
        raise ValueError('PYTHON_SLIM_REQUIRES_DISK')
    for directory in (prefix / 'bin', prefix / 'lib'):
        info = directory.lstat()
        if directory.resolve() != directory or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('PYTHON_SLIM_UNSAFE_DIRECTORY')
    paths = sorted(list((prefix / 'bin').glob('python*')) + list((prefix / 'lib').glob('libpython*.so*')))
    files = []
    for path in paths:
        st = path.lstat()
        if stat.S_ISLNK(st.st_mode):
            if prefix not in path.resolve().parents:
                raise ValueError('PYTHON_SLIM_EXTERNAL_ALIAS')
            continue
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o6022:
            raise ValueError('PYTHON_SLIM_UNSAFE_FILE')
        files.append(path)
    identities = {}
    for path in files:
        st = path.stat(); identities.setdefault((st.st_dev, st.st_ino), []).append(path)
    for group in identities.values():
        if group[0].stat().st_nlink != len(group):
            raise ValueError('PYTHON_SLIM_EXTERNAL_HARDLINK')
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1048576), b''): h.update(block)
        return h.hexdigest()
    before = sum(group[0].stat().st_blocks * 512 for group in identities.values())
    groups = {}
    for path in files:
        st = path.stat()
        key = (digest(path), stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid,
               tuple((key, os.getxattr(str(path), key)) for key in sorted(os.listxattr(str(path)))))
        groups.setdefault(key, []).append(path)
    report = {'beforeAllocatedBytes': before, 'groups': []}
    if symbols is not None:
        symbols = Path(symbols)
        stage = prefix.parents[1] if prefix.name == '.toolchain' else prefix
        if not symbols.is_absolute() or symbols.resolve() != symbols or symbols == stage or stage in symbols.parents:
            raise ValueError('PYTHON_SYMBOL_OUTPUT_MUST_BE_OUTSIDE_STAGE')
        if subprocess.check_output(['stat', '-f', '-c', '%T', str(symbols.parent)]).decode().strip() in ('tmpfs', 'ramfs'):
            raise ValueError('PYTHON_SYMBOL_OUTPUT_REQUIRES_DISK')
        # Explicit existing output is never adopted or overwritten.
        symbols.mkdir(mode=0o700)
    for key, group in sorted(groups.items(), key=lambda item: str(item[1][0])):
        source = group[0]
        row = {'paths': [str(p.relative_to(prefix)) for p in group], 'originalSha256': key[0]}
        with source.open('rb') as stream: elf = stream.read(4) == b'\x7fELF'
        has_debug = elf and symbols is not None and b'.debug_info' in subprocess.check_output(['readelf', '-S', str(source)])
        if has_debug:
            debug = symbols / (key[0] + '.debug')
            subprocess.check_call(['objcopy', '--only-keep-debug', str(source), str(debug)])
            debug.chmod(0o600)
            fd, name = tempfile.mkstemp(prefix='.python-slim-', dir=str(source.parent)); os.close(fd)
            temporary = Path(name)
            try:
                shutil.copy2(str(source), str(temporary))
                subprocess.check_call(['strip', '--strip-debug', str(temporary)])
                if temporary.stat().st_size > source.stat().st_size:
                    raise ValueError('PYTHON_STRIP_GREW_FILE')
                os.chown(str(temporary), source.stat().st_uid, source.stat().st_gid)
                os.replace(str(temporary), str(source))
            finally:
                if temporary.exists(): temporary.unlink()
            row.update(debugFile=debug.name, debugSha256=digest(debug))
        for alias in group[1:]:
            if alias.stat().st_ino == source.stat().st_ino: continue
            # Only already verified identical aliases; no writes through links.
            temporary = alias.with_name(alias.name + '.slim-link')
            os.link(str(source), str(temporary))
            os.replace(str(temporary), str(alias))
        row['sha256'] = digest(source); report['groups'].append(row)
    unique = {(p.stat().st_dev, p.stat().st_ino): p for p in files}
    report['afterAllocatedBytes'] = sum(p.stat().st_blocks * 512 for p in unique.values())
    report['savedAllocatedBytes'] = before - report['afterAllocatedBytes']
    if symbols is not None:
        (symbols / 'symbols.json').write_text(json.dumps(report, indent=2) + '\n')
        (symbols / 'symbols.json').chmod(0o600)
    return report


def freeze(prefix):
    prefix = Path(prefix)
    if not prefix.is_absolute() or prefix.resolve() != prefix or str(prefix) != sys.prefix or sys.prefix == sys.base_prefix:
        raise ValueError('PYTHON_FREEZE_REQUIRES_ACTIVE_STAGED_VENV')
    config = prefix / 'pyvenv.cfg'
    if config.is_symlink() or not config.is_file():
        raise ValueError('PYTHON_VENV_CONFIG_UNSAFE')
    version = '{}.{}'.format(*sys.version_info[:2])
    stdlib = Path(sysconfig.get_path('stdlib')).resolve()
    library = prefix / stdlib.parent.name
    copy_standard_library(stdlib, library / ('python' + version))
    # Copy libpython only. Extension ELF dependencies remain measured on the
    # target; never copy the build-host glibc/loader or a whole library directory.
    for entry in sorted(stdlib.parent.glob('libpython*.so*')):
        destination = library / entry.name
        if destination.exists() or destination.is_symlink():
            raise ValueError('PYTHON_BASE_LIBRARY_CONFLICT: ' + entry.name)
        shutil.copy2(str(entry.resolve()), str(destination))
    # With its stdlib adjacent to bin/, CPython discovers a regular prefix.
    # Keeping pyvenv.cfg would continue importing the build-host base instead.
    config.unlink()
    protect_staged_permissions(prefix)
    slim = slim_staged_python(prefix, os.environ.get('CYF_PYTHON_DEBUG_OUTPUT'))
    print('Runtime Python footprint: ' + json.dumps(slim, sort_keys=True))
    result = subprocess.check_output([str(prefix / 'bin/python'), '-I', '-B', '-c',
        'import json,sys,sysconfig; print(json.dumps([sys.prefix,sys.base_prefix,sysconfig.get_path("stdlib")]))'],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, universal_newlines=True)
    actual = json.loads(result)
    if actual != [str(prefix), str(prefix), str(library / ('python' + version))]:
        raise ValueError('PYTHON_BASE_NOT_SELF_CONTAINED')
    print('Runtime Python base is artifact-local: Python ' + version)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: staged/bin/python freeze-python.py ABSOLUTE_STAGED_VENV')
    freeze(sys.argv[1])
