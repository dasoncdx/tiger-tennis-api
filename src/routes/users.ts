import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role, AccountStatus } from '@prisma/client'

const users = new Hono()

// GET /api/v1/users/coaches — 教练列表（访客可见）
users.get('/coaches', async (c) => {
  const coaches = await prisma.user.findMany({
    where: { role: Role.COACH, status: AccountStatus.ACTIVE },
    include: { coachProfile: true },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({
    success: true,
    data: coaches.map((u) => ({
      id: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl,
      specialty: u.coachProfile?.specialty,
      bio: u.coachProfile?.bio,
      yearsExp: u.coachProfile?.yearsExp,
    })),
  })
})

// GET /api/v1/users/coaches/:id
users.get('/coaches/:id', async (c) => {
  const coach = await prisma.user.findFirst({
    where: { id: c.req.param('id'), role: Role.COACH, status: AccountStatus.ACTIVE },
    include: { coachProfile: true },
  })
  if (!coach) return c.json({ success: false, error: '教练不存在' }, 404)
  return c.json({
    success: true,
    data: {
      id: coach.id,
      name: coach.name,
      avatarUrl: coach.avatarUrl,
      specialty: coach.coachProfile?.specialty,
      bio: coach.coachProfile?.bio,
      yearsExp: coach.coachProfile?.yearsExp,
    },
  })
})

// PATCH /api/v1/users/me
users.patch('/me', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const body = await c.req.json()
  const { name, password, specialty, bio } = body

  const updateData: Record<string, unknown> = {}
  if (name) updateData.name = name
  if (password) {
    if (password.length < 3) return c.json({ success: false, error: '密码至少3位' }, 400)
    updateData.password = await bcrypt.hash(password, 10)
  }

  await prisma.user.update({ where: { id: userId }, data: updateData })

  if (role === Role.COACH && (specialty !== undefined || bio !== undefined)) {
    await prisma.coachProfile.upsert({
      where: { userId },
      update: { specialty, bio },
      create: { userId, specialty, bio },
    })
  }

  return c.json({ success: true, data: { message: '更新成功' } })
})

// ─── 管理员专属 ───────────────────────────────

// GET /api/v1/users/students
users.get('/students', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { page = '1', pageSize = '20', status, ntrpLevel, keyword } = c.req.query()
  const skip = (Number(page) - 1) * Number(pageSize)

  const where: Record<string, unknown> = { role: Role.STUDENT }
  if (status) where.status = status
  if (keyword) where.OR = [
    { name: { contains: keyword } },
    { phone: { contains: keyword } },
  ]

  const [total, students] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: Number(pageSize),
      include: { studentPackages: { where: { endDate: { gt: new Date() } }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return c.json({
    success: true,
    data: {
      total,
      list: students.map((s) => ({
        id: s.id,
        name: s.name,
        phone: s.phone,
        status: s.status,
        createdAt: s.createdAt,
        hasActivePackage: s.studentPackages.length > 0,
      })),
    },
  })
})

// POST /api/v1/users/students — 管理员直接创建学员或教练（role参数）
users.post('/students', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { name, phone, password, remark, role: userRole, bio, specialty } = await c.req.json()
  if (!name || !phone || !password) return c.json({ success: false, error: '缺少必填字段' }, 400)

  const existing = await prisma.user.findUnique({ where: { phone } })
  if (existing) return c.json({ success: false, error: '该手机号已注册' }, 409)

  const roleToUse = userRole === 'COACH' ? Role.COACH : Role.STUDENT

  const user = await prisma.user.create({
    data: {
      name,
      phone,
      password: await bcrypt.hash(password, 10),
      role: roleToUse,
      status: AccountStatus.ACTIVE,
      remark,
      // 如果是教练，同时创建 CoachProfile
      ...(roleToUse === Role.COACH && {
        coachProfile: {
          create: { specialty: specialty || null, bio: bio || null }
        }
      }),
    },
  })
  return c.json({ success: true, data: { id: user.id } }, 201)
})

// GET /api/v1/users/students/:id
users.get('/students/:id', authMiddleware, requireRole(Role.ADMIN, Role.COACH), async (c) => {
  const student = await prisma.user.findFirst({
    where: { id: c.req.param('id'), role: Role.STUDENT },
    include: {
      studentPackages: { include: { template: true }, orderBy: { createdAt: 'desc' } },
      ntrpApplications: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  if (!student) return c.json({ success: false, error: '学员不存在' }, 404)

  // 推导当前段位
  const latestApproved = await prisma.ntrpApplication.findFirst({
    where: { studentId: student.id, status: 'APPROVED' },
    orderBy: { reviewedAt: 'desc' },
  })

  return c.json({
    success: true,
    data: {
      id: student.id,
      name: student.name,
      phone: student.phone,
      status: student.status,
      remark: student.remark,
      createdAt: student.createdAt,
      ntrpLevel: latestApproved?.toLevel ?? null,
      packages: student.studentPackages.map((p) => ({
        id: p.id,
        name: p.template.name,
        type: p.type,
        totalLessons: p.totalLessons,
        usedLessons: p.usedLessons,
        remainingLessons: p.totalLessons - p.usedLessons,
        startDate: p.startDate,
        endDate: p.endDate,
        isExpired: p.endDate < new Date(),
      })),
    },
  })
})

// ─── 学员-教练关联（必须在 /:id 系列路由之前注册）────────────────

// POST /api/v1/users/student-coach — 绑定学员与教练
users.post('/student-coach', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { studentId, coachId } = await c.req.json()
  if (!studentId || !coachId) return c.json({ success: false, error: '缺少参数' }, 400)
  await (prisma as any).studentCoachRelation.upsert({
    where: { studentId_coachId: { studentId, coachId } },
    update: {},
    create: { studentId, coachId },
  })
  return c.json({ success: true, data: { message: '关联成功' } })
})

// DELETE /api/v1/users/student-coach — 解绑
users.delete('/student-coach', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { studentId, coachId } = await c.req.json()
  await (prisma as any).studentCoachRelation.deleteMany({
    where: { studentId, coachId },
  })
  return c.json({ success: true, data: { message: '解绑成功' } })
})

// GET /api/v1/users/coach-students/:coachId — 教练获取自己的学员
users.get('/coach-students/:coachId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const coachId = c.req.param('coachId')
  if (role === Role.COACH && userId !== coachId) {
    return c.json({ success: false, error: '无权限' }, 403)
  }
  const relations = await (prisma as any).studentCoachRelation.findMany({
    where: { coachId },
    include: { student: { select: { id: true, name: true, phone: true, status: true } } } as any,
  })
  return c.json({ success: true, data: (relations as any[]).map((r: any) => r.student) })
})

// GET /api/v1/users/student-coaches/:studentId — 学员关联的教练列表
users.get('/student-coaches/:studentId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const studentId = c.req.param('studentId')
  if (role === Role.STUDENT && userId !== studentId) {
    return c.json({ success: false, error: '无权限' }, 403)
  }
  const relations = await (prisma as any).studentCoachRelation.findMany({
    where: { studentId },
    include: {
      coach: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          coachProfile: { select: { specialty: true, bio: true } },
        },
      },
    } as any,
  })
  return c.json({ success: true, data: (relations as any[]).map((r: any) => ({
    id: r.coach.id,
    name: r.coach.name,
    avatarUrl: r.coach.avatarUrl,
    specialty: r.coach.coachProfile?.specialty,
  })) })
})

// PATCH /api/v1/users/:id — 编辑用户
users.patch('/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { name, remark } = await c.req.json()
  await prisma.user.update({ where: { id: c.req.param('id') }, data: { name, remark } })
  return c.json({ success: true, data: { message: '更新成功' } })
})

// PATCH /api/v1/users/:id/status — 激活/禁用/审批
users.patch('/:id/status', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { status } = await c.req.json()
  if (!['ACTIVE', 'DISABLED'].includes(status)) {
    return c.json({ success: false, error: '状态值不合法' }, 400)
  }
  const user = await prisma.user.update({
    where: { id: c.req.param('id') },
    data: { status },
  })
  if (status === AccountStatus.ACTIVE) {
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'SYSTEM',
        title: '账号已激活',
        content: '您的账号已通过审核，现在可以登录使用了',
      },
    })
  }
  return c.json({ success: true, data: { message: '状态更新成功' } })
})

// POST /api/v1/users/:id/reset-password
users.post('/:id/reset-password', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { password } = await c.req.json()
  if (!password || password.length < 3) return c.json({ success: false, error: '密码至少3位' }, 400)
  await prisma.user.update({
    where: { id: c.req.param('id') },
    data: { password: await bcrypt.hash(password, 10) },
  })
  return c.json({ success: true, data: { message: '密码已重置' } })
})

// GET /api/v1/users/coaches/:id/students
users.get('/coaches/:id/students', authMiddleware, requireRole(Role.ADMIN, Role.COACH), async (c) => {
  const { userId, role } = c.get('user')
  const coachId = c.req.param('id')
  if (role === Role.COACH && userId !== coachId) {
    return c.json({ success: false, error: '无权限' }, 403)
  }
  // 通过bookings关联找负责学员（训练记录/月度报告中有关联的）
  const students = await prisma.user.findMany({
    where: {
      role: Role.STUDENT,
      status: AccountStatus.ACTIVE,
      OR: [
        { trainingNotes: { some: { coachId } } },
        { monthlyReports: { some: { coachId } } },
        { privateBookings: { some: { coachId } } },
      ],
    },
    distinct: ['id'],
    orderBy: { name: 'asc' },
  })
  return c.json({ success: true, data: students.map((s) => ({ id: s.id, name: s.name, avatarUrl: s.avatarUrl })) })
})

export default users
