#!/bin/bash
# Retired Mac mini setup helper.
# The current system is Hub-native; this legacy migration entrypoint must not
# install retired gateway dependencies on new machines.
set -euo pipefail

echo "scripts/migrate/02-setup.sh is retired."
echo "Use scripts/setup-dev.sh, then validate Hub readiness:"
echo "  npm --prefix bots/hub run test:unit"
echo "  npm --prefix bots/hub run check:runtime"
exit 1
