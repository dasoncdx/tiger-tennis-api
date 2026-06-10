import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role, BookingStatus, CourseType } from '@prisma/client'

const bookings = new Hono()

// GET /api/v1/bookings — 预约列表（按角色过滤）
bookings.get('/', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const { status, page = '1', pageSize = '20' } = c.req.query()
  const skip = (Number(page) - 1) * Number(pageSize)

  const where: Record<string, unknown> = {}
  if (role === Role.STUDENT) where.studentId = userId
  if (role === Role.COACH) where.coachId = userId
  if (status) where.status = status

  const [total, list] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      skip,
      take: Number(pageSize),
      include: {
        student: { select: { name: true, avatarUrl: true } },
        coach: { select: { name: true, avatarUrl: true } },
        trainingNote: true,
      },
      orderBy: { startTime: 'asc' },
    }),
  ])
  return c.json({ success: true, data: { total, list } })
})

// POST /api/v1/bookings — 学员提交预约
bookings.post('/', authMiddleware, requireRole(Role.STUDENT), async (c) => {
  const { userId: studentId } = c.get('user')
  const { coachId, startTime, endTime, packageId, remark } = await c.req.json()

  if (!coachId || !startTime || !endTime || !packageId) {
    return c.json({ success: false, error: '缺少必填字段' }, 400)
  }

  // 验证套餐
  const pkg = await prisma.studentPackage.findFirst({
    where: { id: packageId, studentId, type: CourseType.PRIVATE },
  })
  if (!pkg) return c.json({ success: false, error: '私教套餐不存在' }, 404)
  if (pkg.endDate < new Date()) return c.json({ success: false, error: '套餐已过期' }, 400)
  if (pkg.usedLessons >= pkg.totalLessons) return c.json({ success: false, error: '课时已用完' }, 400)

  // 检查时段是否冲突，并在事务中创建预约（防止并发竞争）
  const booking = await prisma.$transaction(async (tx) => {
    const conflict = await tx.booking.findFirst({
      where: {
        coachId,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
        OR: [
          { startTime: { lte: new Date(startTime) }, endTime: { gt: new Date(startTime) } },
          { startTime: { lt: new Date(endTime) }, endTime: { gte: new Date(endTime) } },
        ],
      },
    })
    if (conflict) throw new Error('该时段已被预约')

    return tx.booking.create({
      data: { studentId, coachId, startTime: new Date(startTime), endTime: new Date(endTime), remark, status: BookingStatus.PENDING },
    })
  }).catch((e: Error) => {
    if (e.message === '该时段已被预约') return null
    throw e
  })

  if (!booking) return c.json({ success: false, error: '该时段已被预约' }, 409)
  return c.json({ success: true, data: { id: booking.id } }, 201)
})

// PATCH /api/v1/bookings/:id/confirm — 教练确认
bookings.patch('/:id/confirm', authMiddleware, requireRole(Role.COACH), async (c) => {
  const { userId: coachId } = c.get('user')
  const { venue, remark } = await c.req.json()

  const booking = await prisma.booking.findFirst({ where: { id: c.req.param('id'), coachId } })
  if (!booking) return c.json({ success: false, error: '预约不存在' }, 404)
  if (booking.status !== BookingStatus.PENDING) return c.json({ success: false, error: '该预约无法确认' }, 409)

  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CONFIRMED, venue } })
  return c.json({ success: true, data: { message: '已确认' } })
})

// PATCH /api/v1/bookings/:id/reject — 教练拒绝
bookings.patch('/:id/reject', authMiddleware, requireRole(Role.COACH), async (c) => {
  const { userId: coachId } = c.get('user')
  const { rejectReason } = await c.req.json()
  if (!rejectReason) return c.json({ success: false, error: '拒绝原因必填' }, 400)

  const booking = await prisma.booking.findFirst({
    where: { id: c.req.param('id'), coachId },
    include: { student: true },
  })
  if (!booking) return c.json({ success: false, error: '预约不存在' }, 404)
  if (booking.status !== BookingStatus.PENDING) return c.json({ success: false, error: '该预约无法拒绝' }, 409)

  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED, rejectReason } })

  // 通知学员
  await prisma.notification.create({
    data: {
      userId: booking.studentId,
      type: 'BOOKING',
      title: '预约已被拒绝',
      content: `您的预约被拒绝，原因：${rejectReason}`,
    },
  })

  return c.json({ success: true, data: { message: '已拒绝' } })
})

// PATCH /api/v1/bookings/:id/cancel — 学员取消
bookings.patch('/:id/cancel', authMiddleware, requireRole(Role.STUDENT), async (c) => {
  const { userId: studentId } = c.get('user')
  const booking = await prisma.booking.findFirst({ where: { id: c.req.param('id'), studentId } })
  if (!booking) return c.json({ success: false, error: '预约不存在' }, 404)
  if (booking.status !== BookingStatus.PENDING) return c.json({ success: false, error: '只有待确认的预约可以取消' }, 409)

  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED } })
  return c.json({ success: true, data: { message: '已取消' } })
})

// PATCH /api/v1/bookings/:id/complete — 标记完成并核销课时
bookings.patch('/:id/complete', authMiddleware, requireRole(Role.COACH, Role.ADMIN), async (c) => {
  const { userId: operatorId } = c.get('user')
  const booking = await prisma.booking.findUnique({ where: { id: c.req.param('id') } })
  if (!booking) return c.json({ success: false, error: '预约不存在' }, 404)
  if (booking.status !== BookingStatus.CONFIRMED) return c.json({ success: false, error: '只有已确认的预约可以完成' }, 409)

  // 找学员有效私教套餐（usedLessons < totalLessons 用原生字段比较）
  const pkg = await prisma.studentPackage.findFirst({
    where: {
      studentId: booking.studentId,
      type: CourseType.PRIVATE,
      endDate: { gt: new Date() },
    },
    orderBy: { endDate: 'asc' },
  })
  // 过滤掉已用完的套餐
  const validPkg = pkg && pkg.usedLessons < pkg.totalLessons ? pkg : null

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.COMPLETED } })
    if (validPkg) {
      await tx.studentPackage.update({ where: { id: validPkg.id }, data: { usedLessons: { increment: 1 } } })
      await tx.lessonConsumption.create({ data: { packageId: validPkg.id, bookingId: booking.id, operatorId } })
    }
  })

  return c.json({ success: true, data: { message: '已完成', consumed: !!validPkg } })
})

// GET /api/v1/bookings/coach-schedule/:coachId — 教练开放时段
bookings.get('/coach-schedule/:coachId', authMiddleware, async (c) => {
  const schedules = await prisma.coachSchedule.findMany({
    where: { coachId: c.req.param('coachId'), startTime: { gte: new Date() } },
    orderBy: { startTime: 'asc' },
  })
  // 找出已被预约的时段
  const booked = await prisma.booking.findMany({
    where: {
      coachId: c.req.param('coachId'),
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      startTime: { gte: new Date() },
    },
    select: { startTime: true, endTime: true },
  })
  return c.json({ success: true, data: { schedules, booked } })
})

// POST /api/v1/bookings/coach-schedule
bookings.post('/coach-schedule', authMiddleware, requireRole(Role.COACH, Role.ADMIN), async (c) => {
  const { userId, role } = c.get('user')
  const { coachId, startTime, endTime, isRecurring } = await c.req.json()
  const targetCoachId = role === Role.ADMIN ? coachId : userId
  await prisma.coachSchedule.create({
    data: { coachId: targetCoachId, startTime: new Date(startTime), endTime: new Date(endTime), isRecurring: !!isRecurring },
  })
  return c.json({ success: true, data: { message: '时段已添加' } }, 201)
})

// DELETE /api/v1/bookings/coach-schedule/:id
bookings.delete('/coach-schedule/:id', authMiddleware, requireRole(Role.COACH, Role.ADMIN), async (c) => {
  await prisma.coachSchedule.delete({ where: { id: c.req.param('id') } })
  return c.json({ success: true, data: { message: '时段已删除' } })
})

export default bookings
