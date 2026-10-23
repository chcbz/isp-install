import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('rebase', Path(__file__).resolve().parents[1] / 'shell/cyf_runtime_toolchain_rebase.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RebaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'app'
        self.old = Path(self.tmp.name) / 'old'
        self.venv = self.root / 'codex-ws-agent/.toolchain'
        (self.venv / 'bin').mkdir(parents=True)
        self.paths = {'pyvenv.cfg': 'command = /base/python -m venv --copies ',
                      'bin/activate': 'VIRTUAL_ENV=', 'bin/activate.csh': 'setenv VIRTUAL_ENV ',
                      'bin/activate.fish': 'set -gx VIRTUAL_ENV '}
        for name, prefix in self.paths.items():
            (self.venv / name).write_text(prefix + str(self.old / 'codex-ws-agent/.toolchain') + '\n')

    def test_readonly_then_apply_and_idempotence(self):
        before = (self.venv / 'pyvenv.cfg').read_bytes()
        self.assertEqual(len(module.rebase(self.root, self.old)['changes']), 4)
        self.assertEqual((self.venv / 'pyvenv.cfg').read_bytes(), before)
        self.assertEqual(len(module.rebase(self.root, self.old, True)['changes']), 4)
        self.assertIn(str(self.venv), (self.venv / 'pyvenv.cfg').read_text())
        self.assertEqual(module.rebase(self.root, self.old, True)['changes'], [])

    def test_unknown_reference_fails_before_any_write(self):
        p = self.root / 'unknown.txt'
        p.write_text(str(self.old))
        before = (self.venv / 'pyvenv.cfg').read_bytes()
        with self.assertRaisesRegex(ValueError, 'UNEXPECTED'):
            module.rebase(self.root, self.old, True)
        self.assertEqual((self.venv / 'pyvenv.cfg').read_bytes(), before)

    def test_symlink_or_hardlink_refused(self):
        p = self.root / 'link'
        p.symlink_to(self.old / 'foo')
        with self.assertRaisesRegex(ValueError, 'SYMLINK'):
            module.plan(self.root, self.old)
        p.unlink()
        import os
        os.link(str(self.venv / 'pyvenv.cfg'), str(p))
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            module.plan(self.root, self.old)

    def test_unknown_field_duplicate_reference_refused(self):
        p = self.venv / 'pyvenv.cfg'
        p.write_text('home = ' + str(self.old) + '\n')
        with self.assertRaisesRegex(ValueError, 'UNRECOGNIZED'):
            module.plan(self.root, self.old)

    def test_symlink_root_and_nested_root_refused(self):
        p = Path(self.tmp.name) / 'alias'
        p.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            module.plan(p, self.old)
        with self.assertRaisesRegex(ValueError, 'NON_NESTED'):
            module.plan(self.root, self.root / 'child')
