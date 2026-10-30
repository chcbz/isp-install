#!/bin/bash
# Flow worker build step. Produces a new private stage, never installs/activates it.
# The caller supplies the SHA-verified Python distribution and binds output to its Run.
set -euo pipefail
[ "$#" = 3 ] || { echo 'usage: build-python-toolchain.sh STAGE FINAL_APP VERIFIED_PYTHON' >&2; exit 2; }
STAGE="$1"; FINAL_APP="$2"; PYTHON="$3"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
for path in "$STAGE" "$FINAL_APP" "$PYTHON"; do
  [[ "$path" = /* ]] && [ "$(readlink -m "$path")" = "$path" ] || { echo 'Absolute canonical paths required' >&2; exit 1; }
done
[ -x "$PYTHON" ] && [ ! -e "$STAGE" ] && [ ! -L "$STAGE" ]
mkdir -m 700 "$STAGE"
mkdir -m 700 "$STAGE/codex-bridge"
VENV="$STAGE/codex-bridge/.toolchain"
"$PYTHON" -I -B -m venv --copies "$VENV"
"$VENV/bin/python" -I -B -m pip install --disable-pip-version-check --no-input --no-cache-dir --upgrade 'pip<22'
"$VENV/bin/python" -I -B -m pip install --disable-pip-version-check --no-input --no-cache-dir -r "$SOURCE_DIR/../codex-bridge/toolchain/requirements.txt"
# Reuse the installer's exact generated-launcher relocation, not a second policy.
"$VENV/bin/python" -I -B - "$SOURCE_DIR/install.sh" "$STAGE" "$FINAL_APP" <<'PY'
from pathlib import Path
import subprocess, sys
source, stage, final = sys.argv[1:]
text = Path(source).read_text()
start = "<<'PY_RUNTIME_RELOCATE'\n"
end = '\nPY_RUNTIME_RELOCATE\n'
assert text.count(start) == 1 and text.count(end) == 1, 'INSTALLER_RELOCATE_SNIPPET_CHANGED'
script = text.split(start, 1)[1].split(end, 1)[0]
subprocess.run([sys.executable, '-I', '-S', '-B', '-', stage, final], input=script, encoding='utf-8', check=True)
PY
"$VENV/bin/python" -I -B "$SOURCE_DIR/lib/freeze-python.py" "$VENV"
# Same existing imports/version contract; actual isolation/reopen probe follows in CI.
"$VENV/bin/python" -I -B "$SOURCE_DIR/../codex-bridge/toolchain/delivery_tool.py" health
