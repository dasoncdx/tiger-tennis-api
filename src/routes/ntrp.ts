import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role, NtrpLevel } from '@prisma/client'

const ntrp = new Hono()

// GET /api/v1/ntrp/records/:studentId
ntrp.get('/records/:studentId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const studentId = c.req.param('studentId')
  if (role === Role.STUDENT && userId !== studentId) {
    return c.json({ success: false, error: '无权限' }, 403)
  }
  const records = await prisma.ntrpRecord.findMany({
    where: { studentId },
    include: { coach: { select: { name: true } }, application: true },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: records })
})

// POST /api/v1/ntrp/records — 教练提交评估
ntrp.post('/records', authMiddleware, requireRole(Role.COACH), async (c) => {
  const { userId: coachId } = c.get('user')
  const body = await c.req.json()
  const { studentId, forehand, backhand, serve, movement, tactics, matchMindset, remark, applyPromotion, toLevel } = body

  if (!studentId || forehand == null || backhand == null || serve == null || movement == null || tactics == null) {
    return c.json({ success: false, error: '缺少评估数据' }, 400)
  }

  // 检查是否有待审批的申请
  if (applyPromotion) {
    const pending = await prisma.ntrpApplication.findFirst({
      where: { studentId, status: 'PENDING' },
    })
    if (pending) return c.json({ success: false, error: '该学员已有待审批的晋级申请' }, 409)
  }

  // 推导当前段位
  const currentApproved = await prisma.ntrpApplication.findFirst({
    where: { studentId, status: 'APPROVED' },
    orderBy: { reviewedAt: 'desc' },
  })
  const currentLevel = currentApproved?.toLevel ?? NtrpLevel.LEVEL_2_5B

  const record = await prisma.ntrpRecord.create({
    data: { studentId, coachId, forehand, backhand, serve, movement, tactics, matchMindset, remark, applyPromotion: !!applyPromotion },
  })

  if (applyPromotion && toLevel) {
    await prisma.ntrpApplication.create({
      data: { studentId, recordId: record.id, fromLevel: currentLevel, toLevel },
    })
    // 通知管理员
    const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } })
    const student = await prisma.user.findUnique({ where: { id: studentId }, select: { name: true } })
    await Promise.all(admins.map((a) =>
      prisma.notification.create({
        data: {
          userId: a.id,
          type: 'NTRP',
          title: '新晋级申请',
          content: `${student?.name} 申请从 ${currentLevel} 晋级至 ${toLevel}，请审批`,
        },
      })
    ))
  }

  return c.json({ success: true, data: { id: record.id } }, 201)
})

// GET /api/v1/ntrp/applications
ntrp.get('/applications', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { status, page = '1', pageSize = '20' } = c.req.query()
  const skip = (Number(page) - 1) * Number(pageSize)
  const where = status ? { status: status as any } : {}
  const [total, list] = await Promise.all([
    prisma.ntrpApplication.count({ where }),
    prisma.ntrpApplication.findMany({
      where,
      skip,
      take: Number(pageSize),
      include: {
        student: { select: { name: true } },
        record: true,
        reviewer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  return c.json({ success: true, data: { total, list } })
})

// PATCH /api/v1/ntrp/applications/:id — 审批/驳回
ntrp.patch('/applications/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { userId: reviewerId } = c.get('user')
  const { status, reviewRemark } = await c.req.json()
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return c.json({ success: false, error: '状态值不合法' }, 400)
  }

  const app = await prisma.ntrpApplication.findUnique({
    where: { id: c.req.param('id') },
    include: { student: true, record: { include: { coach: true } } },
  })
  if (!app) return c.json({ success: false, error: '申请不存在' }, 404)
  if (app.status !== 'PENDING') return c.json({ success: false, error: '该申请已处理' }, 409)

  await prisma.ntrpApplication.update({
    where: { id: app.id },
    data: { status, reviewerId, reviewRemark, reviewedAt: new Date() },
  })

  if (status === 'APPROVED') {
    // 通知学员和教练
    await Promise.all([
      prisma.notification.create({
        data: {
          userId: app.studentId,
          type: 'NTRP',
          title: '晋级申请已通过',
          content: `恭喜！您已成功晋级至 ${app.toLevel.replace('LEVEL_', '').replace('_', '.')}`,
        },
      }),
      prisma.notification.create({
        data: {
          userId: app.record.coachId,
          type: 'NTRP',
          title: '晋级申请已通过',
          content: `您提交的 ${app.student.name} 晋级申请已通过审批`,
        },
      }),
    ])
  } else {
    await prisma.notification.create({
      data: {
        userId: app.record.coachId,
        type: 'NTRP',
        title: '晋级申请被驳回',
        content: `${app.student.name} 的晋级申请已被驳回${reviewRemark ? `，原因：${reviewRemark}` : ''}`,
      },
    })
  }

  return c.json({ success: true, data: { message: '审批完成' } })
})

// GET /api/v1/ntrp/config
ntrp.get('/config', authMiddleware, async (c) => {
  const config = await prisma.siteConfig.findUnique({ where: { key: 'ntrp_standards' } })
  return c.json({ success: true, data: { content: config?.value ?? '' } })
})

// PUT /api/v1/ntrp/config
ntrp.put('/config', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { content } = await c.req.json()
  await prisma.siteConfig.upsert({
    where: { key: 'ntrp_standards' },
    update: { value: content },
    create: { key: 'ntrp_standards', value: content },
  })
  return c.json({ success: true, data: { message: '保存成功' } })
})

export default ntrp
