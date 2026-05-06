const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error('Missing or weak JWT_SECRET. Use at least 32 characters.');
  }

  return secret;
}

function signUserToken(userId) {
  return jwt.sign(
    {
      sub: String(userId),
      type: 'user',
    },
    getJwtSecret(),
    {
      expiresIn: '180d',
    }
  );
}

function authRequired(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    const payload = jwt.verify(token, getJwtSecret());

    if (!payload?.sub || payload.type !== 'user') {
      return res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
    }

    req.auth = {
      userId: String(payload.sub),
    };

    return next();
  } catch {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN',
    });
  }
}

function requireSameUserParam(paramName = 'userId') {
  return function requireSameUser(req, res, next) {
    const requestedUserId = String(req.params[paramName] || '');
    const authenticatedUserId = String(req.auth?.userId || '');

    if (!mongoose.Types.ObjectId.isValid(requestedUserId)) {
      return res.status(400).json({
        error: 'Invalid user id',
        code: 'INVALID_USER_ID',
      });
    }

    if (requestedUserId !== authenticatedUserId) {
      return res.status(403).json({
        error: 'Forbidden',
        code: 'FORBIDDEN_USER',
      });
    }

    return next();
  };
}

module.exports = {
  authRequired,
  requireSameUserParam,
  signUserToken,
};