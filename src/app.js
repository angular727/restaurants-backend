const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const { rateLimit } = require('express-rate-limit');
const mongoose = require('mongoose');
const env = require('./config/env');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

/**
 * CORS: which browser origins (your frontend) may call the API.
 *   - CORS_ORIGINS set  → only those origins
 *   - unset in dev      → any origin (convenient while building the frontend)
 *   - unset in prod     → no browser origins at all (fail closed)
 * Auth uses a Bearer token (not cookies), so credentials mode is not needed.
 */
function corsOptions() {
  const allowAll = !env.isProduction && env.corsOrigins.length === 0;
  const allowed = new Set(env.corsOrigins);
  return {
    origin: allowAll ? true : (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Tenant-Slug', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600, // browsers cache the preflight for 10 minutes
  };
}

function rateLimitBody(message) {
  return { error: { code: 'RATE_LIMITED', message } };
}

function createApp() {
  const app = express();

  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  // Request id: returned in a header and in logs, so a frontend error can be traced
  // to the exact server log line. An upstream proxy's id is reused if present.
  app.use((req, res, next) => {
    const incoming = req.get('X-Request-Id');
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });

  morgan.token('id', (req) => req.id);
  app.use(
    morgan(env.logFormat === 'combined' ? ':id :remote-addr ":method :url" :status :res[content-length] - :response-time ms' : 'dev', {
      skip: (req) => req.path === '/health',
    })
  );

  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // Liveness + DB readiness, for Docker/Kubernetes/load-balancer health checks.
  app.get('/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', uptime: Math.round(process.uptime()) });
  });

  // Rate limits are per client IP and kept in memory. With several API instances, use a
  // shared store (e.g. rate-limit-redis) so the limits are global.
  const apiLimiter = rateLimit({
    windowMs: env.rateLimit.windowMs,
    limit: env.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitBody('Too many requests, slow down'),
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.rateLimit.authMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true, // only failed logins count, which blocks brute-force but not real users
    message: rateLimitBody('Too many failed attempts, try again in 15 minutes'),
  });

  app.use('/api', apiLimiter);
  app.use(['/api/v1/auth/login', '/api/v1/auth/register'], authLimiter);
  app.use('/api/v1', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
