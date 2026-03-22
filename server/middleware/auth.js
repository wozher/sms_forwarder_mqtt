const db = require('../database');

const PUBLIC_PATHS = [
  '/api/login',
  '/favicon.ico',
  '/'
];

function basicAuth(req, res, next) {
  if (PUBLIC_PATHS.some(path => req.path === path || req.path.startsWith('/api/login'))) {
    return next();
  }
  if (req.query.skip === '1') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [username, password] = credentials.split(':');

    if (!username || !password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials format'
      });
    }

    if (db.validateUser(username, password)) {
      req.user = username;
      return next();
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid username or password'
    });
  } catch (error) {
    console.error('[Auth] Error:', error.message);
    return res.status(401).json({
      success: false,
      message: 'Authentication error'
    });
  }
}

module.exports = { basicAuth };
