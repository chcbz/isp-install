import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('python_artifact', Path(__file__).resolve().parents[1] / 'conf/cyf-agent-runtime-v1/lib/python-artifact.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PythonArtifactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        (self.source / 'lib').mkdir(parents=True)
        (self.source / 'lib/python.txt').write_text('fixed Python fixture')
        (self.source / 'lib64').symlink_to('lib')
        self.archive = self.root / 'python.tar.gz'
        self.manifest = self.root / 'python.json'
        self.target = self.root / 'target'

    def test_roundtrip_preserves_internal_link_without_duplicate_library(self):
        module.pack(self.source, self.archive, self.manifest)
        module.extract(self.archive, self.manifest, self.target)
        self.assertEqual(module.inventory(self.source), module.inventory(self.target))
        self.assertTrue((self.target / 'lib64').is_symlink())
        self.assertEqual((self.target / 'lib64/python.txt').read_text(), 'fixed Python fixture')
        self.assertEqual(len(list(self.target.rglob('python.txt'))), 1)
        with self.assertRaisesRegex(ValueError, 'NEW_TARGET'):
            module.extract(self.archive, self.manifest, self.target)

    def test_corrupt_archive_rejected_without_creating_target(self):
        module.pack(self.source, self.archive, self.manifest)
        with self.archive.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'DIGEST_MISMATCH'):
            module.extract(self.archive, self.manifest, self.target)
        self.assertFalse(self.target.exists())

    def malicious(self, rows):
        with tarfile.open(str(self.archive), 'w:gz') as stream:
            for row in rows:
                member = tarfile.TarInfo(row['path'])
                member.mode = row['mode']
                if row['type'] == 'symlink':
                    member.type = tarfile.SYMTYPE
                    member.linkname = row['target']
                    stream.addfile(member)
                else:
                    member.size = 1
                    stream.addfile(member, io.BytesIO(b'x'))
        self.manifest.write_text(json.dumps({'schemaVersion': 1, 'sha256': module.sha(self.archive), 'entries': rows}))
        with self.assertRaises(ValueError):
            module.extract(self.archive, self.manifest, self.target)
        self.assertFalse(self.target.exists())

    def test_writable_and_privileged_file_modes_remain_rejected(self):
        for mode in (0o664, 0o775, 0o4755, 0o2755):
            self.malicious([{'path': 'unsafe', 'type': 'file', 'mode': mode,
                            'sha256': hashlib.sha256(b'x').hexdigest()}])

    def test_traversal_rejected_before_writing(self):
        self.malicious([{'path': '../escape', 'type': 'file', 'mode': 0o644, 'sha256': hashlib.sha256(b'x').hexdigest()}])

    def test_link_escape_rejected_before_writing(self):
        self.malicious([{'path': 'escape', 'type': 'symlink', 'mode': 0o777, 'target': '/etc'}])

    def test_write_through_link_rejected_before_writing(self):
        self.malicious([{'path': 'link', 'type': 'symlink', 'mode': 0o777, 'target': 'lib'},
                        {'path': 'link/file', 'type': 'file', 'mode': 0o644, 'sha256': hashlib.sha256(b'x').hexdigest()}])

    def test_duplicate_members_rejected(self):
        row = {'path': 'same', 'type': 'file', 'mode': 0o644, 'sha256': hashlib.sha256(b'x').hexdigest()}
        self.malicious([row, row])

    def test_pack_rejects_host_link_and_nested_output(self):
        (self.source / 'outside').symlink_to('/etc')
        with self.assertRaisesRegex(ValueError, 'LINK_OUTSIDE'):
            module.pack(self.source, self.archive, self.manifest)
        with self.assertRaisesRegex(ValueError, 'OUTPUT_INSIDE'):
            module.pack(self.source, self.source / 'nested.tar.gz', self.manifest)


if __name__ == '__main__':
    unittest.main()
