#!/bin/bash
# Retired source entry: no PID/service/workspace action, config read or fallback.
# Installed historical services are not retired by this source change.
printf '%s\n' 'UNIFIED_RUNTIME_ENTRY_REQUIRED: legacy Agent launcher is retired. Use the unified Runtime artifact-local Node with an explicit --config; service activation and historical maintenance require separate authorization.' >&2
exit 2
