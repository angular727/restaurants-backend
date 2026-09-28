const mongoose = require('mongoose');
const env = require('./env');

// Only filter on fields defined in the schema. A typo like { tenantID: x } would otherwise
// silently match *every* document, which would leak data across tenants.
mongoose.set('strictQuery', true);

async function connectDB(uri = env.mongoUri) {
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));
  mongoose.connection.on('error', (err) => console.error('[db] error', err.message));

  await mongoose.connect(uri, {
    // Building indexes at boot is fine in dev. In production run `npm run sync-indexes`
    // (the Docker image does this before starting) so big index builds don't block start-up.
    autoIndex: env.autoIndex,
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10_000,
  });
  // Log the host only, never the URI: it contains credentials.
  console.log(`[db] connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB };
