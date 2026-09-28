/**
 * Creates the indexes declared on the schemas and drops indexes that are no longer
 * declared. Run it as a deploy step in production, where autoIndex is off.
 */
const { connectDB, disconnectDB } = require('../config/db');
const models = require('../models');

(async () => {
  await connectDB();
  for (const [name, Model] of Object.entries(models)) {
    const dropped = await Model.syncIndexes();
    console.log(`[indexes] ${name}: synced${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
  }
  await disconnectDB();
})().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
