#!/usr/bin/env bash
# Builds dist/agent.jar (needs a JDK 17+). The jar is reproducible, so players
# only download a new agent when the code changes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
rm -rf build dist
mkdir -p build/classes dist
javac --release 17 -encoding UTF-8 -d build/classes $(find src -name '*.java')
printf 'Premain-Class: mcmanager.agent.Agent\nMain-Class: mcmanager.agent.Agent\n' > build/MANIFEST.MF
jar --create --date=2026-01-01T00:00:00Z --file dist/agent.jar --manifest build/MANIFEST.MF -C build/classes .
echo "Built $(pwd)/dist/agent.jar ($(wc -c < dist/agent.jar) bytes)"
