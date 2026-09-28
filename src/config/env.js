require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

function required(name, devFallback) {
  const value = process.env[name];
  if (value) return value;
  if (!isProduction && devFallback !== undefined) return devFallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * TRUST_PROXY: how many reverse proxies (nginx, a load balancer, Cloudflare) sit in front
 * of the app. It must be exact. Too low and every client shares the proxy's IP (rate limits
 * hit everyone). Too high and clients can fake their IP through X-Forwarded-For.
 * Use 0 when the app is exposed directly.
 */
function trustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : raw; // numeric hop count, or a subnet list like "loopback, 10.0.0.0/8"
}

const env = {
  nodeEnv,
  isProduction,
  port: int('PORT', 4000),
  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/restaurant_saas'),
  useTransactions: process.env.USE_TRANSACTIONS !== 'false',
  // Build indexes when the app starts. Off by default in production (use `npm run sync-indexes`).
  autoIndex: process.env.AUTO_INDEX ? process.env.AUTO_INDEX === 'true' : !isProduction,

  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  // Browser origins allowed to call the API, e.g. "https://app.example.com,http://localhost:5173".
  // Empty in development = allow any origin. Empty in production = allow none (server-to-server only).
  corsOrigins: list('CORS_ORIGINS'),
  trustProxy: trustProxy(),

  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    max: int('RATE_LIMIT_MAX', 300), // per IP per window, all API routes
    authMax: int('RATE_LIMIT_AUTH_MAX', 10), // per IP per 15 min, login/register
  },
  logFormat: process.env.LOG_FORMAT || (isProduction ? 'combined' : 'dev'),
};

// Refuse to start production with unsafe settings instead of failing silently later.
if (isProduction) {
  if (env.jwtSecret.length < 32 || env.jwtSecret.includes('change-me')) {
    throw new Error('JWT_SECRET must be a random string of at least 32 characters in production');
  }
  if (!env.useTransactions) {
    console.warn('[env] USE_TRANSACTIONS=false in production: stock/order updates are NOT atomic');
  }
}

module.exports = env;
