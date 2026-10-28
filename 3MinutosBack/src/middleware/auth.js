const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error('Missing or weak JWT_SECRET. Use at least 32 characters.');
  }

  return secret;
}

// El token dura 180 días y no hay login para pedir otro: si vence, el usuario pierde la cuenta. Por eso cada
// pedido autenticado con un token de más de TOKEN_REFRESH_AFTER_DAYS días devuelve uno nuevo en este header, y la
// app lo guarda (services/api.ts del front). Mientras el usuario abra la app al menos una vez cada 180 días, nunca vence.
const TOKEN_EXPIRES_IN = '180d';
const TOKEN_REFRESH_AFTER_DAYS = 7;
const REFRESHED_TOKEN_HEADER = 'X-Auth-Token';

/** true si el token (payload ya verificado) tiene más de `afterDays` días y conviene renovarlo. */
function shouldRefreshToken(payload, { now = Date.now(), afterDays = TOKEN_REFRESH_AFTER_DAYS } = {}) {
  const issuedAt = Number(payload?.iat);
  if (!Number.isFinite(issuedAt)) return true; // un token sin fecha de emisión se reemplaza por uno con fecha
  return now / 1000 - issuedAt >= afterDays * 86400;
}

function signUserToken(userId) {
  return jwt.sign(
    {
      sub: String(userId),
      type: 'user',
    },
    getJwtSecret(),
    {
      expiresIn: TOKEN_EXPIRES_IN,
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

    if (shouldRefreshToken(payload)) {
      res.set(REFRESHED_TOKEN_HEADER, signUserToken(payload.sub));
    }

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
  REFRESHED_TOKEN_HEADER,
  TOKEN_REFRESH_AFTER_DAYS,
  shouldRefreshToken,
  authRequired,
  requireSameUserParam,
  signUserToken,
};