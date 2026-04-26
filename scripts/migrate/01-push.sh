#!/bin/bash
# Retired Mac mini migration helper.
# The old migration path copied legacy gateway state and is intentionally disabled.
set -euo pipefail

echo "scripts/migrate/01-push.sh is retired."
echo "Use scripts/setup-dev.sh plus Hub runtime checks instead:"
echo "  npm --prefix bots/hub run test:unit"
echo "  npm --prefix bots/hub run check:runtime"
exit 1
