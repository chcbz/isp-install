import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'conf/cyf-agent-runtime-v1/lib/freeze-python.py'
spec = importlib.util.spec_from_file_location('freeze_python', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FreezeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cyf-python-freeze-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_preserves_installed_packages_and_excludes_base_packages_and_bytecode(self):
        source, target = self.root / 'base', self.root / 'stage'
        for directory in (source / 'site-packages', source / 'encodings/__pycache__', target / 'site-packages'):
            directory.mkdir(parents=True)
        (source / 'site-packages/untrusted.py').write_text('base package')
        (source / 'encodings/__init__.py').write_text('# stdlib')
        (source / 'encodings/__pycache__/x.pyc').write_bytes(b'cached')
        (target / 'site-packages/locked.py').write_text('fixed package')
        module.copy_standard_library(source, target)
        self.assertEqual((target / 'site-packages/locked.py').read_text(), 'fixed package')
        self.assertFalse((target / 'site-packages/untrusted.py').exists())
        self.assertFalse((target / 'encodings/__pycache__').exists())
        self.assertEqual((target / 'encodings/__init__.py').read_text(), '# stdlib')
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'):
            module.copy_standard_library(source, target)

    def test_upstream_writable_modes_are_normalized_without_following_links(self):
        stage = self.root / 'stage'
        (stage / 'lib').mkdir(parents=True)
        executable = stage / 'python'
        executable.write_bytes(b'fixture')
        executable.chmod(0o775)
        library = stage / 'lib/module.py'
        library.write_bytes(b'fixture')
        library.chmod(0o664)
        (stage / 'lib').chmod(0o775)
        outside = self.root / 'outside'
        outside.write_bytes(b'unchanged')
        outside.chmod(0o664)
        (stage / 'external').symlink_to(outside)
        (stage / 'lib64').symlink_to('lib')
        module.protect_staged_permissions(stage)
        self.assertEqual(executable.stat().st_mode & 0o7777, 0o755)
        self.assertEqual(library.stat().st_mode & 0o7777, 0o644)
        self.assertEqual((stage / 'lib').stat().st_mode & 0o7777, 0o755)
        self.assertEqual(outside.stat().st_mode & 0o7777, 0o664)
        self.assertTrue((stage / 'lib64').is_symlink())
        (stage / 'external').unlink()
        artifact_spec = importlib.util.spec_from_file_location('artifact', SCRIPT.with_name('python-artifact.py'))
        artifact = importlib.util.module_from_spec(artifact_spec)
        artifact_spec.loader.exec_module(artifact)
        archive, manifest = self.root / 'python.tgz', self.root / 'python.json'
        artifact.pack(stage, archive, manifest)
        artifact.extract(archive, manifest, self.root / 'extracted')
        self.assertEqual(artifact.inventory(stage), artifact.inventory(self.root / 'extracted'))

    def test_refuses_modifying_non_active_or_base_interpreter(self):
        with self.assertRaisesRegex(ValueError, 'REQUIRES_ACTIVE_STAGED_VENV'):
            module.freeze(str(self.root))

    @unittest.skipUnless(os.environ.get('CYF_TEST_FREEZE_PYTHON'), 'explicit diagnostic interpreter required')
    def test_real_interpreter_stays_self_contained_after_directory_move(self):
        stage = self.root / 'stage'
        subprocess.check_call([os.environ['CYF_TEST_FREEZE_PYTHON'], '-I', '-B', '-m', 'venv', '--copies', '--without-pip', str(stage)])
        subprocess.check_call([str(stage / 'bin/python'), '-I', '-B', str(SCRIPT), str(stage)])
        self.assertFalse((stage / 'pyvenv.cfg').exists())
        final = self.root / 'moved'
        shutil.move(str(stage), str(final))
        result = subprocess.check_output([str(final / 'bin/python'), '-I', '-B', '-c',
            'import json,sys,sysconfig,ssl,zlib,ctypes,sqlite3; print(json.dumps([sys.prefix,sys.base_prefix,sysconfig.get_path("stdlib")]))'],
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, universal_newlines=True)
        prefix, base, stdlib = json.loads(result)
        self.assertEqual(prefix, str(final))
        self.assertEqual(base, str(final))
        self.assertTrue(stdlib.startswith(str(final) + '/'))

class FlowBuildEntryTest(unittest.TestCase):
    def test_worker_entry_accepts_verified_distribution_python_alias(self):
        with tempfile.TemporaryDirectory(prefix='cyf-python-entry-test-') as temporary:
            root = Path(temporary)
            real = root / 'python3.11'
            real.write_text('#!/bin/sh\necho VERIFIED_PYTHON_INVOKED >&2\nexit 37\n')
            real.chmod(0o700)
            alias = root / 'python3'
            alias.symlink_to('python3.11')
            stage = root / 'stage'
            command = ['bash', str(SCRIPT.parents[1] / 'build-python-toolchain.sh'), str(stage), str(root / 'final'), str(alias)]
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            self.assertEqual(result.returncode, 37, result.stderr)
            self.assertIn('VERIFIED_PYTHON_INVOKED', result.stderr)
            second = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertNotIn('VERIFIED_PYTHON_INVOKED', second.stderr)

    def test_worker_entry_reuses_installer_launcher_rules_and_freezes_new_stage(self):
        root = SCRIPT.parents[3]
        source = (root / 'conf/cyf-agent-runtime-v1/build-python-toolchain.sh').read_text()
        self.assertIn('text.count(start) == 1 and text.count(end) == 1', source)
        self.assertIn('[ ! -e "$STAGE" ] && [ ! -L "$STAGE" ]', source)
        self.assertLess(source.index('subprocess.run('), source.index('"$VENV/bin/python" -I -B "$SOURCE_DIR/lib/freeze-python.py"'))
        self.assertNotIn('systemctl', source)
        self.assertIn('PIP_INDEX="https://mirrors.aliyun.com/pypi/simple/"', source)
        self.assertEqual(source.count('--index-url "$PIP_INDEX"'), 2)
        self.assertNotIn('--trusted-host', source)
        pin = json.loads((root / 'conf/cyf-agent-runtime-v1/python-source.json').read_text())
        self.assertEqual(pin['version'], '3.11.13')
        self.assertEqual(len(pin['sha256']), 64)
        self.assertTrue(pin['url'].startswith('https://github.com/astral-sh/python-build-standalone/releases/download/'))


class SlimPythonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cyf-python-slim-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stage = self.root / 'stage/codex-bridge/.toolchain'
        (self.stage / 'bin').mkdir(parents=True)
        (self.stage / 'lib').mkdir()

    def put(self, name, data=b'identical fixture', mode=0o755):
        p = self.stage / name; p.write_bytes(data); p.chmod(mode); return p

    def test_identical_aliases_share_inode_and_different_bytes_or_modes_do_not(self):
        a = self.put('bin/python'); b = self.put('bin/python3'); c = self.put('bin/python3.11')
        lib = self.put('lib/libpython3.so',b'libfixture',0o644)
        alias = self.put('lib/libpython3.so.1',b'libfixture',0o644)
        different = self.put('bin/python-other',b'other fixture')
        mode = self.put('bin/python-mode',mode=0o700)
        result = module.slim_staged_python(self.stage)
        self.assertEqual(a.stat().st_ino,b.stat().st_ino); self.assertEqual(a.stat().st_ino,c.stat().st_ino)
        self.assertEqual(lib.stat().st_ino,alias.stat().st_ino)
        self.assertNotEqual(a.stat().st_ino,different.stat().st_ino)
        self.assertNotEqual(a.stat().st_ino,mode.stat().st_ino)
        self.assertGreater(result['savedAllocatedBytes'],0)
        self.assertEqual(module.slim_staged_python(self.stage)['savedAllocatedBytes'],0)

    def test_existing_installer_private_stage_is_allowed_but_live_and_backups_are_not(self):
        self.assertTrue(module.private_stage_location('/home/isp/apps/cyf-agent-runtime-v1/.cyf-agent-runtime.stage.Ab1234/codex-bridge/.toolchain'))
        self.assertFalse(module.private_stage_location('/home/isp/apps/cyf-agent-runtime-v1/app/codex-bridge/.toolchain'))
        self.assertFalse(module.private_stage_location('/home/isp/baks/cyf-agent-runtime-v1/20261109-old/old-program/codex-bridge/.toolchain'))

    def test_external_hardlink_is_rejected_without_mutation(self):
        p = self.put('bin/python'); os.link(str(p),str(self.root/'outside'))
        with self.assertRaisesRegex(ValueError,'EXTERNAL_HARDLINK'): module.slim_staged_python(self.stage)
        self.assertEqual(p.read_bytes(),b'identical fixture')

    def test_external_symlink_and_installed_paths_rejected(self):
        (self.stage/'bin/python').symlink_to('/usr/bin/python3')
        with self.assertRaisesRegex(ValueError,'EXTERNAL_ALIAS'): module.slim_staged_python(self.stage)
        with self.assertRaisesRegex(ValueError,'REFUSES_INSTALLED'): module.slim_staged_python(Path('/home/isp/apps/example'))

    def test_debug_output_not_inside_stage_and_never_overwritten(self):
        self.put('bin/python')
        with self.assertRaisesRegex(ValueError,'OUTSIDE_STAGE'): module.slim_staged_python(self.stage,self.stage/'symbols')
        existing=self.root/'symbols'; existing.mkdir()
        with self.assertRaises(FileExistsError): module.slim_staged_python(self.stage,existing)

    @unittest.skipUnless(shutil.which('cc') and shutil.which('strip') and shutil.which('objcopy'),'ELF toolchain required')
    def test_real_elf_strip_symbols_saved_outside_stage_and_execution_still_works(self):
        src=self.root/'main.c'; src.write_text('int main(void) { return 0; }\n')
        exe=self.stage/'bin/python'
        subprocess.check_call(['cc','-g','-o',str(exe),str(src)])
        shutil.copy2(str(exe),str(self.stage/'bin/python3'))
        symbols=self.root/'debug-symbols'
        result=module.slim_staged_python(self.stage,symbols)
        subprocess.check_call([str(exe)])
        self.assertEqual(exe.stat().st_ino,(self.stage/'bin/python3').stat().st_ino)
        self.assertTrue((symbols/'symbols.json').exists())
        self.assertEqual(len(list(symbols.glob('*.debug'))),1)
        self.assertTrue(result['groups'][0]['debugSha256'])
        sections=subprocess.check_output(['readelf','-S',str(exe)]).decode()
        self.assertNotIn('.debug_info',sections)

if __name__ == '__main__':
    unittest.main()
