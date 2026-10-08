#!/bin/bash
# Single artifact: pinned Node, Runtime, mature engine, locked JS deps and Python tools.
# No activation, state adoption, enrollment, service control or legacy .env copy.
set -euo pipefail
usage() {
    echo 'usage: install.sh --target ABSOLUTE_NEW_DIRECTORY [--node NODE20] [--npm NPM_CLI] [--python PYTHON3] [--engine-root ENGINE_SOURCE]' >&2
    exit 2
}
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET=''
NODE_BIN="${CYF_RUNTIME_V1_NODE_BIN:-node}"
NPM_CLI="${CYF_RUNTIME_V1_NPM_CLI:-npm}"
PYTHON_BIN="${CYF_RUNTIME_V1_PYTHON_BIN:-python3}"
ENGINE_ROOT="$(dirname "$SOURCE_DIR")/codex-ws-agent"
while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || usage
    case "$1" in
        --target) TARGET="$2" ;;
        --node) NODE_BIN="$2" ;;
        --npm) NPM_CLI="$2" ;;
        --python) PYTHON_BIN="$2" ;;
        --engine-root) ENGINE_ROOT="$2" ;;
        *) usage ;;
    esac
    shift 2
done
case "$TARGET" in /*) ;; *) usage ;; esac
[ "$(readlink -m "$TARGET")" = "$TARGET" ] || { echo 'Runtime target must be canonical' >&2; exit 1; }
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo 'Runtime target exists; do not adopt or overwrite it' >&2; exit 1; }
PARENT="$(dirname "$TARGET")"
[ -d "$PARENT" ] && [ "$(readlink -f "$PARENT")" = "$PARENT" ] || { echo 'Runtime target parent must exist and be canonical' >&2; exit 1; }
resolve_bin() { command -v "$1" 2>/dev/null || true; }
NODE_BIN="$(resolve_bin "$NODE_BIN")"
NPM_CLI="$(resolve_bin "$NPM_CLI")"
PYTHON_BIN="$(resolve_bin "$PYTHON_BIN")"
[ -x "$NODE_BIN" ] && [ -f "$NPM_CLI" ] && [ -x "$PYTHON_BIN" ] || { echo 'Node/npm/Python toolchain unavailable' >&2; exit 1; }
[ "$("$NODE_BIN" -p 'process.versions.node')" = '20.20.2' ] || { echo 'Runtime requires pinned Node 20.20.2' >&2; exit 1; }
STAGE="$(mktemp -d "$PARENT/.cyf-agent-runtime.stage.XXXXXX")"
# STAGE is exclusively created above. Never delete a pre-existing target.
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT
install -d -m 0755 "$STAGE/runtime/lib" "$STAGE/runtime/systemd" "$STAGE/node/bin"
install -m 0755 "$(readlink -f "$NODE_BIN")" "$STAGE/node/bin/node"
for file in agent-runtime.mjs install.sh validate.sh; do
    install -m 0755 "$SOURCE_DIR/$file" "$STAGE/runtime/$file"
done
for file in README.md package.json runtime.env.example manifest.example.json lib/manifest.mjs lib/runtime-client.mjs \
    lib/security.mjs lib/runtime-host.mjs lib/execution-adapter.mjs systemd/cyf-agent-runtime-v1@.service; do
    install -m 0644 "$SOURCE_DIR/$file" "$STAGE/runtime/$file"
done
"$STAGE/node/bin/node" --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const { collateExecutionPayload } = await import(pathToFileURL(process.argv[1]));
  await collateExecutionPayload(process.argv[2], process.argv[3]);
' "$SOURCE_DIR/lib/execution-adapter.mjs" "$ENGINE_ROOT" "$STAGE/codex-ws-agent"
# Fixed lockfile, no install scripts, no host/global npm installation.
(cd "$STAGE/codex-ws-agent" && "$STAGE/node/bin/node" "$(readlink -f "$NPM_CLI")" ci --ignore-scripts --no-audit --no-fund)
"$PYTHON_BIN" -m venv --copies "$STAGE/codex-ws-agent/.toolchain"
"$STAGE/codex-ws-agent/.toolchain/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir --upgrade 'pip<22'
"$STAGE/codex-ws-agent/.toolchain/bin/python" -m pip install --disable-pip-version-check --no-input --no-cache-dir \
    -r "$STAGE/codex-ws-agent/toolchain/requirements.txt"
# Prepare generated venv launchers and cfg audit metadata BEFORE validating the stage. Python
# --copies relocates the interpreter, not pip's absolute shebangs or activation.
# Relative shell/Python trampolines work both before and after mv, including long
# paths; no base-interpreter/stdlib portability or production compiler claim.
"$STAGE/codex-ws-agent/.toolchain/bin/python" -I -S -B - "$STAGE" "$TARGET" <<'PY_RUNTIME_RELOCATE'
import base64, csv, hashlib, io, os, re, shlex, sys
stage, target = sys.argv[1:]
venv = os.path.join(stage, 'codex-ws-agent', '.toolchain')
bin_dir = os.path.join(venv, 'bin')
final_venv = os.path.join(target, 'codex-ws-agent', '.toolchain')
changed = {}
def save(path, data):
    # Preserve original executable/ownership modes; all paths are in our stage.
    with open(path, 'wb') as stream: stream.write(data)
    changed[path] = data

# Python 3.11 adds a command audit field to pyvenv.cfg. Its final env_dir is
# raw text (not shell-quoted by CPython), even for paths with spaces/quotes.
# Rewrite only that recognized final operand; never strip markers or rewrite
# home/base-executable/unknown fields. This audit line is never executed.
cfg_path = os.path.join(venv, 'pyvenv.cfg')
assert os.path.isfile(cfg_path) and not os.path.islink(cfg_path), 'VENV_CONFIG_UNSAFE'
with open(cfg_path, 'rb') as stream: cfg_data = stream.read()
if stage.encode() in cfg_data or b'.cyf-agent-runtime.stage.' in cfg_data:
    cfg_text = cfg_data.decode('utf-8')
    cfg_lines = cfg_text.splitlines(True)
    commands = [(index, re.fullmatch(r'(command\s*=\s*)([^\r\n]*)(\r?\n)?', line))
                for index, line in enumerate(cfg_lines) if re.match(r'command\s*=', line)]
    assert len(commands) == 1 and commands[0][1], 'VENV_CONFIG_COMMAND_NOT_RECOGNIZED'
    index, match = commands[0]
    value = match.group(2)
    # Exact suffix, not an arbitrary occurrence or predicted stage path. Keep
    # original quoting style if the audit producer explicitly POSIX-quoted it.
    if value.endswith(' ' + venv):
        prefix, destination = value[:-len(venv)], final_venv
    elif value.endswith(' ' + shlex.quote(venv)):
        prefix, destination = value[:-len(shlex.quote(venv))], shlex.quote(final_venv)
    else:
        raise AssertionError('VENV_CONFIG_COMMAND_NOT_RECOGNIZED')
    assert re.fullmatch(r'(/.+) -m venv --copies(?: --without-pip)? ', prefix), 'VENV_CONFIG_COMMAND_NOT_RECOGNIZED'
    assert stage not in prefix and '.cyf-agent-runtime.stage.' not in prefix, 'VENV_CONFIG_BASE_CONTAINS_STAGE'
    cfg_lines[index] = match.group(1) + prefix + destination + (match.group(3) or '')
    cfg_text = ''.join(cfg_lines)
    assert stage not in cfg_text and '.cyf-agent-runtime.stage.' not in cfg_text, 'VENV_CONFIG_STAGE_REFERENCE_NOT_RECOGNIZED'
    save(cfg_path, cfg_text.encode('utf-8'))

def interpreter_name(value):
    assert value.startswith(bin_dir + '/'), 'VENV_LAUNCHER_INTERPRETER_OUTSIDE_STAGE'
    name = value[len(bin_dir) + 1:]
    assert re.fullmatch(r'(?:platform-)?python[0-9.]*', name), 'VENV_LAUNCHER_INTERPRETER_INVALID'
    assert os.path.isfile(os.path.join(bin_dir, name)), 'VENV_LAUNCHER_INTERPRETER_MISSING'
    return name

for name in sorted(os.listdir(bin_dir)):
    path = os.path.join(bin_dir, name)
    if os.path.islink(path):
        assert stage not in os.readlink(path), 'VENV_STAGE_SYMLINK_NOT_RELOCATABLE'
        continue
    if not os.path.isfile(path): continue
    with open(path, 'rb') as stream: data = stream.read()
    if stage.encode() not in data: continue
    text = data.decode('utf-8')  # Unknown binary stage references fail closed.
    lines = text.splitlines(True)
    if lines[0].startswith('#!' + bin_dir + '/'):
        interpreter = interpreter_name(lines[0][2:].strip())
        body = ''.join(lines[1:])
    elif lines[0].strip() == '#!/bin/sh' and len(lines) >= 3:
        match = re.fullmatch(r"'''exec' (.+) \"\$0\" \"\$@\"\n", lines[1])
        assert match and lines[2].strip() == "' '''", 'VENV_TRAMPOLINE_NOT_RECOGNIZED'
        arguments = shlex.split(match.group(1))
        assert len(arguments) == 1, 'VENV_TRAMPOLINE_INTERPRETER_INVALID'
        interpreter = interpreter_name(arguments[0])
        body = ''.join(lines[3:])
    elif name in ('activate', 'activate.csh', 'activate.fish'):
        if name == 'activate':
            pattern, assignment = r'^VIRTUAL_ENV=.*$', 'VIRTUAL_ENV=' + shlex.quote(final_venv)
        else:
            escaped = final_venv.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$')
            if name == 'activate.csh':
                escaped = escaped.replace('`', '\\`').replace('!', '\\!')
                pattern, assignment = r'^setenv VIRTUAL_ENV .*$', 'setenv VIRTUAL_ENV "' + escaped + '"'
            else:
                pattern, assignment = r'^set -gx VIRTUAL_ENV .*$', 'set -gx VIRTUAL_ENV "' + escaped + '"'
        text, count = re.subn(pattern, lambda _: assignment, text, flags=re.MULTILINE)
        assert count == 1 and stage not in text, 'VENV_ACTIVATION_NOT_RELOCATABLE'
        save(path, text.encode('utf-8'))
        continue
    else:
        raise AssertionError('VENV_STAGE_REFERENCE_NOT_RECOGNIZED')
    assert stage not in body, 'VENV_LAUNCHER_BODY_CONTAINS_STAGE_REFERENCE'
    header = ("#!/bin/sh\n'''exec' \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd -P)/"
              + interpreter + "\" \"$0\" \"$@\"\n' '''\n")
    save(path, (header + body).encode('utf-8'))

# Retain installed distribution integrity for the rewritten generated scripts.
# Metadata is finalized in the stage, so stage->target RECORD hashes stay equal.
for directory, _, files in os.walk(os.path.join(venv, 'lib')):
    if not directory.endswith('.dist-info') or 'RECORD' not in files: continue
    record = os.path.join(directory, 'RECORD')
    with open(record, newline='') as stream: rows = list(csv.reader(stream))
    updated = False
    for row in rows:
        path = os.path.normpath(os.path.join(os.path.dirname(directory), row[0]))
        if path in changed:
            data = changed[path]
            row[1:] = ['sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='), str(len(data))]
            updated = True
    if updated:
        output = io.StringIO(newline='')
        csv.writer(output).writerows(rows)
        with open(record, 'w', newline='') as stream: stream.write(output.getvalue())
print('Runtime venv launchers prepared for publication: %d' % len(changed))
PY_RUNTIME_RELOCATE
"$STAGE/runtime/validate.sh" --root "$STAGE"
# Do not let a competing operator install be overwritten between preflight and publication.
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo 'Runtime target appeared during staging' >&2; exit 1; }
mv -T -n "$STAGE" "$TARGET"
[ ! -d "$STAGE" ] || { echo 'Runtime target publication lost ownership' >&2; exit 1; }
trap - EXIT
"$TARGET/runtime/validate.sh" --root "$TARGET"
printf '%s\n' "Runtime artifact installed without activation: $TARGET"
