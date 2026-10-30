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


if __name__ == '__main__':
    unittest.main()
