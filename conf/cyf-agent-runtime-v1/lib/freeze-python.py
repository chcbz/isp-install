"""Make a privately staged venv independent of its build-host base Python.

Build-worker operation only: no download, compilation, service or state changes.
The enclosing artifact manifest binds every copied file; runtime still measures
ELF dependencies on the target and executes the actual isolated document probe.
"""
import json
import os
from pathlib import Path
import shutil
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
