const env = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const createApp = require('./app');

let server;
let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if connections hang
  try {
    // Stop accepting new connections and let in-flight requests finish (e.g. a payment).
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDB();
  } finally {
    process.exit(exitCode);
  }
}

async function start() {
  await connectDB();
  const app = createApp();
  server = app.listen(env.port, () => {
    console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
  });

  // Keep idle keep-alive sockets open longer than the load balancer's timeout (60 s on
  // AWS ALB and nginx defaults). Otherwise the proxy can reuse a closed socket and return a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM')); // what Docker/Kubernetes send on stop
}

// Log crashes, then exit so the process manager (Docker restart policy, PM2) restarts a
// clean process instead of running on in an unknown state.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception', err);
  shutdown('uncaughtException', 1);
});

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
