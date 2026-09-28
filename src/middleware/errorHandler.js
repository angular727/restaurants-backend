const mongoose = require('mongoose');
const { AppError } = require('../utils/errors');
const env = require('../config/env');

function notFoundHandler(req, _res, next) {
  next(new AppError(404, `Route ${req.method} ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500;
  let body = { code: 'INTERNAL_ERROR', message: 'Something went wrong' };

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { code: err.code, message: err.message, details: err.details };
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    body = {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    };
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    body = { code: 'INVALID_ID', message: `Invalid value for ${err.path}` };
  } else if (err?.code === 11000) {
    status = 409;
    body = { code: 'DUPLICATE', message: 'A record with these values already exists', details: err.keyValue };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'INVALID_JSON', message: 'Malformed JSON body' };
  }

  body.requestId = req.id; // lets the frontend show "error ref: …" that matches a server log line
  if (status >= 500) {
    console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, err);
    if (!env.isProduction) body.stack = err.stack; // never leak stack traces in production
  }
  res.status(status).json({ error: body });
}

module.exports = { notFoundHandler, errorHandler };
