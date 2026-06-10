import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { signToken } from '../lib/jwt'
import { Role, AccountStatus } from '@prisma/client'
import { authMiddleware } from '../middleware/auth'

const auth = new Hono()

// POST /api/v1/auth/register
auth.post('/register', async (c) => {
  const body = await c.req.json()
  const { name, phone, password, role, remark } = body

  if (!name || !phone || !password || !role) {
    return c.json({ success: false, error: '请填写完整信息' }, 400)
  }
  if (!/^1\d{10}$/.test(phone)) {
    return c.json({ success: false, error: '手机号格式不正确' }, 400)
  }
  if (password.length < 3) {
    return c.json({ success: false, error: '密码至少3位' }, 400)
  }
  if (!['STUDENT', 'COACH'].includes(role)) {
    return c.json({ success: false, error: '角色不合法' }, 400)
  }

  const existing = await prisma.user.findUnique({ where: { phone } })
  if (existing) {
    return c.json({ success: false, error: '该手机号已注册' }, 409)
  }

  const hashed = await bcrypt.hash(password, 10)
  await prisma.user.create({
    data: {
      name,
      phone,
      password: hashed,
      role: role as Role,
      status: AccountStatus.PENDING,
      remark,
    },
  })

  // 通知管理员有新注册
  const admins = await prisma.user.findMany({ where: { role: Role.ADMIN, status: AccountStatus.ACTIVE } })
  await Promise.all(
    admins.map((admin) =>
      prisma.notification.create({
        data: {
          userId: admin.id,
          type: 'SYSTEM',
          title: '新账号待审批',
          content: `${name}（${role === 'STUDENT' ? '学员' : '教练'}）申请注册，请及时审批`,
        },
      })
    )
  )

  return c.json({ success: true, data: { message: '注册成功，等待管理员审批' } }, 201)
})

// POST /api/v1/auth/login
auth.post('/login', async (c) => {
  const body = await c.req.json()
  const { phone, password } = body

  if (!phone || !password) {
    return c.json({ success: false, error: '请输入手机号和密码' }, 400)
  }

  const user = await prisma.user.findUnique({ where: { phone } })
  if (!user) {
    return c.json({ success: false, error: '手机号或密码错误' }, 401)
  }

  const match = await bcrypt.compare(password, user.password)
  if (!match) {
    return c.json({ success: false, error: '手机号或密码错误' }, 401)
  }

  if (user.status === AccountStatus.PENDING) {
    return c.json({ success: false, error: '账号待审批，请等待管理员激活' }, 403)
  }
  if (user.status === AccountStatus.DISABLED) {
    return c.json({ success: false, error: '账号已被禁用，请联系管理员' }, 403)
  }

  const token = signToken({ userId: user.id, role: user.role, status: user.status })

  return c.json({
    success: true,
    data: {
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
        role: user.role,
        avatarUrl: user.avatarUrl,
      },
    },
  })
})

// GET /api/v1/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { coachProfile: true },
  })
  if (!user) return c.json({ success: false, error: '用户不存在' }, 404)

  return c.json({
    success: true,
    data: {
      id: user.id,
      name: user.name,
      phone: user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      role: user.role,
      status: user.status,
      avatarUrl: user.avatarUrl,
      coachProfile: user.coachProfile,
    },
  })
})

export default auth
