import { Context, Next } from 'hono'
import { verifyToken, JwtPayload } from '../lib/jwt'
import { Role } from '@prisma/client'

// 将 payload 注入到 ctx 变量
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未登录' }, 401)
  }
  const token = authHeader.slice(7)
  try {
    const payload = verifyToken(token)
    if (payload.status !== 'ACTIVE') {
      return c.json({ success: false, error: '账号未激活' }, 403)
    }
    c.set('user', payload)
    await next()
  } catch {
    return c.json({ success: false, error: 'token无效或已过期' }, 401)
  }
}

export function requireRole(...roles: Role[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user')
    if (!user || !roles.includes(user.role)) {
      return c.json({ success: false, error: '无权限' }, 403)
    }
    await next()
  }
}
