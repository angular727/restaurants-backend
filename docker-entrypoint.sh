#!/bin/sh
set -e

# Build/update MongoDB indexes before serving traffic (autoIndex is off in production).
# Set SYNC_INDEXES_ON_START=false when running several API replicas, and run
# `node src/scripts/syncIndexes.js` once per deploy instead.
if [ "${SYNC_INDEXES_ON_START:-true}" = "true" ]; then
  node src/scripts/syncIndexes.js
fi

# exec: node becomes PID 1 and receives SIGTERM directly, so graceful shutdown works.
exec node src/server.js
