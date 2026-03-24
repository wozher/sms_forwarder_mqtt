const db = require('../database');

const PUBLIC_PATHS = [
  '/api/login',
  '/favicon.ico',
  '/'
];

function parseBasicAuthHeader(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  const base64Credentials = authHeader.slice(6).trim();
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const separatorIndex = credentials.indexOf(':');

  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: credentials.slice(0, separatorIndex),
    password: credentials.slice(separatorIndex + 1)
  };
}

function basicAuth(req, res, next) {
  if (PUBLIC_PATHS.some(path => req.path === path || req.path.startsWith('/api/login'))) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({
      success: false,
      message: '请先登录'
    });
  }

  try {
    const parsedCredentials = parseBasicAuthHeader(authHeader);

    if (!parsedCredentials) {
      return res.status(401).json({
        success: false,
        message: '登录请求无效，请重新输入'
      });
    }

    const { username, password } = parsedCredentials;

    if (!username || !password) {
      return res.status(401).json({
        success: false,
        message: '登录请求无效，请重新输入'
      });
    }

    if (db.validateUser(username, password)) {
      req.user = username;
      return next();
    }

    return res.status(401).json({
      success: false,
      message: '账号或密码错误'
    });
  } catch (error) {
    console.error('[Auth] Error:', error.message);
    return res.status(401).json({
      success: false,
      message: '登录请求无效，请重新输入'
    });
  }
}

module.exports = { basicAuth };
