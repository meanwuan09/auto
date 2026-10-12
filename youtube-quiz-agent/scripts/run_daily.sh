#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
python -m app.cli run-daily
