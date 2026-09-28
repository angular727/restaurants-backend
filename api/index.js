// Vercel serverless entry. The normal server (src/server.js) is untouched and still used locally / in Docker.
const createApp = require('../src/app');
const { connectDB } = require('../src/config/db');

let app;
let ready;

module.exports = async (req, res) => {
  try {
    if (!ready) {
      ready = connectDB()
        .then(() => {
          app = createApp();
        })
        .catch((err) => {
          ready = null;
          throw err;
        });
    }
    await ready;
    return app(req, res);
  } catch (err) {
    console.error('[vercel] startup failed', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } }));
  }
};
