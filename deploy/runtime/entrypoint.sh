#!/bin/sh
# Entrypoint for one per-user DSH runtime container.
#
# The supervisor appends the app arguments (`web --patch ... --host <ip> --port
# 3080 ...`) and runs the container with the user's mounted workspace as its
# working directory. Absolute paths are required: a bare `tsx/esm` or relative
# CLI path would resolve against that workspace and fail. The supervisor also
# sets TSX_TSCONFIG_PATH to /app/tsconfig.json for the repository path aliases.
set -eu
exec node --import /app/node_modules/tsx/dist/esm/index.mjs /app/apps/cli/src/bin.ts "$@"
