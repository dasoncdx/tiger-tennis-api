import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role, CourseType } from '@prisma/client'

const packages = new Hono()

// GET /api/v1/packages/templates — 上架套餐（访客可见）
packages.get('/templates', async (c) => {
  const list = await prisma.coursePackageTemplate.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({ success: true, data: list })
})

// POST /api/v1/packages/templates
packages.post('/templates', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  const { name, type, totalLessons, price, validDays, imageUrl } = body
  if (!name || !type || !totalLessons || !price || !validDays) {
    return c.json({ success: false, error: '缺少必填字段' }, 400)
  }
  const tpl = await prisma.coursePackageTemplate.create({
    data: { name, type, totalLessons: Number(totalLessons), price: Number(price), validDays: Number(validDays), imageUrl },
  })
  return c.json({ success: true, data: { id: tpl.id } }, 201)
})

// PATCH /api/v1/packages/templates/:id
packages.patch('/templates/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  const { name, price, validDays, imageUrl, isActive } = body
  await prisma.coursePackageTemplate.update({
    where: { id: c.req.param('id') },
    data: { name, price: price != null ? Number(price) : undefined, validDays: validDays != null ? Number(validDays) : undefined, imageUrl, isActive },
  })
  return c.json({ success: true, data: { message: '更新成功' } })
})

// GET /api/v1/packages/student/:studentId — 学员套餐
packages.get('/student/:studentId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const studentId = c.req.param('studentId')
  if (role === Role.STUDENT && userId !== studentId) {
    return c.json({ success: false, error: '无权限' }, 403)
  }
  const now = new Date()
  const list = await prisma.studentPackage.findMany({
    where: { studentId },
    include: { template: true, consumptions: { orderBy: { createdAt: 'desc' }, take: 20 } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({
    success: true,
    data: list.map((p) => ({
      id: p.id,
      templateName: p.template.name,
      type: p.type,
      totalLessons: p.totalLessons,
      usedLessons: p.usedLessons,
      remainingLessons: p.totalLessons - p.usedLessons,
      startDate: p.startDate,
      endDate: p.endDate,
      isExpired: p.endDate < now,
      consumptions: p.consumptions,
    })),
  })
})

// POST /api/v1/packages/student — 为学员发放套餐
packages.post('/student', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { userId: operatorId } = c.get('user')
  const { studentId, templateId, startDate, remark } = await c.req.json()
  const tpl = await prisma.coursePackageTemplate.findUnique({ where: { id: templateId } })
  if (!tpl) return c.json({ success: false, error: '套餐模板不存在' }, 404)

  const start = startDate ? new Date(startDate) : new Date()
  const end = new Date(start.getTime() + tpl.validDays * 24 * 60 * 60 * 1000)

  const pkg = await prisma.studentPackage.create({
    data: {
      studentId,
      templateId,
      type: tpl.type,
      totalLessons: tpl.totalLessons,
      usedLessons: 0,
      startDate: start,
      endDate: end,
      remark,
    },
  })
  return c.json({ success: true, data: { id: pkg.id } }, 201)
})

// POST /api/v1/packages/consume — 手动核销（管理员补录）
packages.post('/consume', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { userId: operatorId } = c.get('user')
  const { packageId, bookingId, remark } = await c.req.json()

  const pkg = await prisma.studentPackage.findUnique({ where: { id: packageId } })
  if (!pkg) return c.json({ success: false, error: '套餐不存在' }, 404)
  if (pkg.usedLessons >= pkg.totalLessons) return c.json({ success: false, error: '课时已用完' }, 400)
  if (pkg.endDate < new Date()) return c.json({ success: false, error: '套餐已过期' }, 400)

  await prisma.$transaction([
    prisma.studentPackage.update({ where: { id: packageId }, data: { usedLessons: { increment: 1 } } }),
    prisma.lessonConsumption.create({ data: { packageId, bookingId, operatorId, remark } }),
  ])

  return c.json({ success: true, data: { message: '核销成功' } })
})

export default packages
