"""Synthetic worker build regression: stub npm/curl, no downloads or production packaging."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parents[1]


class BrowserArtifactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.tools = self.root / 'bin'
        self.tools.mkdir()
        runtime = self.root / 'conf/cyf-agent-runtime-v1'
        runtime.mkdir(parents=True)
        self.script = runtime / 'build-browser-toolchain.sh'
        shutil.copyfile(str(REPO / 'conf/cyf-agent-runtime-v1/build-browser-toolchain.sh'), str(self.script))
        self.source = self.root / 'conf/codex-bridge/toolchain/browser'
        self.source.mkdir(parents=True)
        for name in ['package.json', 'package-lock.json']:
            (self.source / name).write_text('{}')
        with zipfile.ZipFile(str(self.root / 'chrome'), 'w') as archive:
            archive.writestr('chrome-headless-shell-linux64/chrome-headless-shell', 'synthetic executable')
            archive.writestr('chrome-headless-shell-linux64/LICENSE.headless_shell', 'synthetic license')
        (self.root / 'font').write_text('synthetic font')
        (self.root / 'license').write_text('synthetic font license')
        self.sources = {}
        for key, file in [('chromium', 'chrome'), ('font', 'font'), ('fontLicense', 'license')]:
            self.sources[key] = {'url': 'fixture://' + file, 'name': file,
                'sha256': hashlib.sha256((self.root / file).read_bytes()).hexdigest()}
        self.sources['chromium']['version'] = 'fixture-version'
        (self.tools / 'npm').write_text('''#!/usr/bin/python3
import sys,pathlib
root=pathlib.Path(sys.argv[sys.argv.index('--prefix')+1])/'node_modules/playwright-core'
root.mkdir(parents=True)
(root/'browsers.json').write_text('{"browsers":[{"name":"chromium-headless-shell","browserVersion":"fixture-version"}]}')
''')
        (self.tools / 'curl').write_text('''#!/usr/bin/python3
import sys,os,pathlib,shutil
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
url=sys.argv[sys.argv.index('-o')-1]
with (root/'downloads').open('a') as stream: stream.write(url+'\\n')
shutil.copyfile(str(root/url.split('://')[1]),sys.argv[sys.argv.index('-o')+1])
''')
        for tool in self.tools.iterdir():
            tool.chmod(0o755)
        self.stage = self.root / 'stage'

    def build(self):
        (self.source / 'sources.json').write_text(json.dumps(self.sources))
        return subprocess.run(['bash', str(self.script), str(self.stage)],
            env=dict(os.environ, PATH=str(self.tools) + ':/usr/bin:/bin', FIXTURE_ROOT=str(self.root)),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def test_shared_stage_keeps_sdk_browser_fonts_and_licenses(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.stage / 'chromium/chrome-headless-shell').stat().st_mode & 0o777, 0o755)
        self.assertTrue((self.stage / 'chromium/LICENSE.headless_shell').is_file())
        self.assertTrue((self.stage / 'node_modules/playwright-core/browsers.json').is_file())
        self.assertEqual((self.stage / 'fonts/license').read_text(), 'synthetic font license')
        self.assertFalse((self.stage / 'chromium.zip').exists())

    def test_corrupt_download_does_not_extract_or_try_other_source(self):
        self.sources['chromium']['sha256'] = '0' * 64
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('BROWSER_SOURCE_DIGEST_MISMATCH', result.stderr)
        self.assertFalse((self.stage / 'chromium').exists())
        self.assertEqual((self.root / 'downloads').read_text().splitlines(), ['fixture://chrome'])


if __name__ == '__main__':
    unittest.main()
