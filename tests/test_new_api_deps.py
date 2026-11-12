"""Isolated installer regression tests; no daemon/network/production data access."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DependencyInstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'shell').mkdir()
        (self.root / 'conf/new-api-deps').mkdir(parents=True)
        (self.root / 'bin').mkdir()
        # Root ownership is verified by the real installer; tests run without privileges.
        common = 'check_root() { :; }; __red() { echo "$1"; }; __green() { echo "$1"; }\n'
        (self.root / 'shell/common.sh').write_text(common)
        source = (ROOT / 'shell/new_api_deps_install.sh').read_text()
        source = source.replace('/home/isp', str(self.root / 'host'))
        source = source.replace('/run/lock/isp-new-api-deps.lock', str(self.root / 'lock'))
        source = source.replace('"$(stat -c %u "$CONF_DIR/.env")" == 0',
                                f'"$(stat -c %u "$CONF_DIR/.env")" == {os.getuid()}')
        self.script = self.root / 'shell/new_api_deps_install.sh'
        self.script.write_text(source)
        self.template = self.root / 'conf/new-api-deps/compose.yaml'
        self.template.write_text((ROOT / 'conf/new-api-deps/compose.yaml').read_text())
        docker = self.root / 'bin/docker'
        docker.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1 $2" == "compose --env-file" && -n "${POSTGRES_IMAGE:-}" ]]; then echo "INHERITED_IMAGE=$POSTGRES_IMAGE" >> "$MOCK_LOG"; fi
if [[ "$*" == *" pull "* && "${FAIL_PULL:-}" == 1 ]]; then exit 1; fi
if [[ "$1 $2" == 'image inspect' ]]; then
  if [[ "${BAD_DIGEST:-}" == 1 ]]; then echo invalid; exit 0; fi
  image="${@: -1}"
  printf '%s@sha256:%064d\\n' "${image%%[:@]*}" 1
fi
''')
        docker.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{self.root}/bin:{os.environ["PATH"]}',
                        MOCK_LOG=str(self.root / 'commands'))
        self.credentials = self.root / 'host/conf/new-api-deps/.env'
        self.app = self.root / 'host/apps/new-api-deps'
        self.state = self.root / 'host/state/new-api-deps'

    def run_installer(self, **extra):
        return subprocess.run(['bash', str(self.script)], env=dict(self.env, **extra),
                              universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_initial_install_locks_images_and_protects_credentials(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        contents = self.credentials.read_text()
        self.assertIn('POSTGRES_IMAGE=postgres@sha256:', contents)
        self.assertIn('REDIS_IMAGE=redis@sha256:', contents)
        self.assertEqual(self.credentials.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.app.stat().st_mode & 0o777, 0o700)
        self.assertNotIn(contents.split('POSTGRES_PASSWORD=')[1].splitlines()[0], result.stdout)
        commands = (self.root / 'commands').read_text()
        self.assertIn('up -d --wait --wait-timeout 180', commands)

    def test_reinstall_preserves_secrets_and_digest(self):
        self.assertEqual(self.run_installer().returncode, 0)
        original = self.credentials.read_bytes()
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual(self.credentials.read_bytes(), original)

    def test_refuses_existing_data_without_credentials(self):
        self.state.mkdir(parents=True)
        (self.state / 'postgres').mkdir()
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse(self.credentials.exists())

    def test_refuses_modified_compose(self):
        self.app.mkdir(parents=True)
        (self.app / 'compose.yaml').write_text('operator configuration')
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'operator configuration')

    def test_refuses_symlink_credentials(self):
        self.credentials.parent.mkdir(parents=True)
        victim = self.root / 'victim'
        victim.write_text('unchanged')
        self.credentials.symlink_to(victim)
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual(victim.read_text(), 'unchanged')

    def test_refuses_symlink_data_root(self):
        self.state.parent.mkdir(parents=True)
        self.state.symlink_to(self.root)
        self.assertNotEqual(self.run_installer().returncode, 0)

    def test_pull_failure_never_starts_services(self):
        result = self.run_installer(FAIL_PULL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('up -d', (self.root / 'commands').read_text())
        original = self.credentials.read_bytes()
        self.assertEqual(self.run_installer().returncode, 0)
        for key in ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'SESSION_SECRET']:
            old = next(line for line in original.decode().splitlines() if line.startswith(key + '='))
            self.assertIn(old, self.credentials.read_text())

    def test_explicit_registry_and_reinstall_ignore_overrides(self):
        initial = self.run_installer(POSTGRES_IMAGE='public.ecr.aws/docker/library/postgres:15-bookworm',
                                     REDIS_IMAGE='public.ecr.aws/docker/library/redis:7.4-bookworm')
        self.assertEqual(initial.returncode, 0, initial.stdout + initial.stderr)
        self.assertIn('POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres@sha256:',
                      self.credentials.read_text())
        original = self.credentials.read_bytes()
        self.assertEqual(self.run_installer(POSTGRES_IMAGE='untrusted/changed:latest').returncode, 0)
        self.assertEqual(self.credentials.read_bytes(), original)
        self.assertNotIn("INHERITED_IMAGE=", (self.root / "commands").read_text())

    def test_existing_engine_is_not_restarted_or_reinstalled(self):
        common = self.root / 'shell/common.sh'
        with common.open('a') as output:
            output.write('detect_os() { OS=ubuntu; }; pkg_install() { exit 99; }; '
                         'service_start() { exit 99; }; service_enable() { exit 99; }\n')
        script = self.root / 'shell/docker_install.sh'
        script.write_text((ROOT / 'shell/docker_install.sh').read_text())
        result = subprocess.run(['bash', str(script)], env=self.env,
                                universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('left unchanged', result.stdout)

    def test_invalid_digest_never_starts_services(self):
        self.assertNotEqual(self.run_installer(BAD_DIGEST='1').returncode, 0)
        self.assertNotIn('up -d', (self.root / 'commands').read_text())


class ResourceTests(unittest.TestCase):
    def test_private_persistent_template(self):
        text = (ROOT / 'conf/new-api-deps/compose.yaml').read_text()
        self.assertNotIn('ports:', text)
        self.assertNotIn('latest', text)
        self.assertIn('new-api-backend', text)
        self.assertIn('--appendonly yes', text)
        self.assertIn('/home/isp/state/new-api-deps/postgres', text)
        self.assertIn('/home/isp/state/new-api-deps/redis', text)
        self.assertIn('max-size: 10m', text)

    def test_profile_does_not_use_native_database_installers(self):
        text = (ROOT / 'install.sh').read_text()
        self.assertIn('["new-api-deps"]="docker new-api-deps"', text)
        self.assertIn('["docker"]="docker_install.sh"', text)

    def test_bash_syntax(self):
        for path in ['install.sh', 'shell/docker_install.sh', 'shell/new_api_deps_install.sh']:
            subprocess.run(['bash', '-n', str(ROOT / path)], check=True)


if __name__ == '__main__':
    unittest.main()
