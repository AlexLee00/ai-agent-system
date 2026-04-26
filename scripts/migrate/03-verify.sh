#!/bin/bash
# Retired Mac mini verification helper.
# Keep this file as a guardrail so stale runbooks fail closed instead of
# validating retired gateway services.
set -euo pipefail

echo "scripts/migrate/03-verify.sh is retired."
echo "Use Hub readiness checks instead:"
echo "  npm --prefix bots/hub run test:unit"
echo "  npm --prefix bots/hub run check:runtime"
exit 1
