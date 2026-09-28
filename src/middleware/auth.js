const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User } = require('../models');
const { unauthorized } = require('../utils/errors');

function signToken(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/**
 * Verifies the Bearer JWT and loads the user. The token proves WHO the user is. It says
 * nothing about WHICH restaurant they are working in. That is decided per request by
 * resolveTenant, so one login can switch between restaurants without re-authenticating.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.get('Authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    // User is a global (non-tenant) model, so no tenant context is needed here.
    const user = await User.findById(payload.sub).lean();
    if (!user || user.status !== 'active') throw unauthorized('Account not found or disabled');

    req.user = { id: String(user._id), email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticate, signToken };
