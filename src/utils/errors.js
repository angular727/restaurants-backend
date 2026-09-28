class AppError extends Error {
  constructor(statusCode, message, code = 'ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, code = 'BAD_REQUEST', details) => new AppError(400, msg, code, details);
const unauthorized = (msg = 'Authentication required') => new AppError(401, msg, 'UNAUTHORIZED');
const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, msg, 'FORBIDDEN');
const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'NOT_FOUND');
const conflict = (msg, code = 'CONFLICT', details) => new AppError(409, msg, code, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
