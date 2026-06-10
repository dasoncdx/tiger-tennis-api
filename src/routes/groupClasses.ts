import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role, GroupClassType, BookingStatus, CourseType } from '@prisma/client'

const groupClasses = new Hono()

// GET /api/v1/group-classes — 上架班级列表（访客可见）
groupClasses.get('/', async (c) => {
  const list = await prisma.groupClass.findMany({
    where: { status: 'ACTIVE' },
    include: {
      coach: { select: { name: true, avatarUrl: true } },
      _count: { select: { enrollments: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({
    success: true,
    data: list.map((g) => ({
      id: g.id,
      name: g.name,
      coachName: g.coach.name,
      coachAvatarUrl: g.coach.avatarUrl,
      classType: g.classType,
      ntrpRange: g.ntrpRange,
      capacity: g.capacity,
      enrolledCount: g._count.enrollments,
      isFull: g._count.enrollments >= g.capacity,
      weekday: g.weekday,
      startTimeStr: g.startTimeStr,
      endTimeStr: g.endTimeStr,
      venue: g.venue,
    })),
  })
})

// POST /api/v1/group-classes
groupClasses.post('/', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  const { name, coachId, classType, venue, ntrpRange, capacity, lessonsPerSession, description, weekday, startTimeStr, endTimeStr, effectiveFrom, sessions } = body

  const gc = await prisma.groupClass.create({
    data: {
      name, coachId, classType, venue, ntrpRange,
      capacity: Number(capacity),
      lessonsPerSession: Number(lessonsPerSession) || 1,
      description, weekday, startTimeStr, endTimeStr,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
    },
  })

  // 限期班：手动添加课次
  if (classType === GroupClassType.FIXED && sessions?.length) {
    await prisma.groupSession.createMany({
      data: sessions.map((s: { startTime: string; endTime: string; venue?: string }) => ({
        classId: gc.id,
        startTime: new Date(s.startTime),
        endTime: new Date(s.endTime),
        venue: s.venue,
      })),
    })
  }

  // 循环班：自动生成12周课次
  if (classType === GroupClassType.RECURRING && weekday != null && startTimeStr && endTimeStr && effectiveFrom) {
    const sessions12 = []
    const base = new Date(effectiveFrom)
    for (let i = 0; i < 12; i++) {
      const d = new Date(base)
      d.setDate(d.getDate() + i * 7)
      const [sh, sm] = startTimeStr.split(':').map(Number)
      const [eh, em] = endTimeStr.split(':').map(Number)
      const start = new Date(d); start.setHours(sh, sm, 0, 0)
      const end = new Date(d); end.setHours(eh, em, 0, 0)
      sessions12.push({ classId: gc.id, startTime: start, endTime: end })
    }
    await prisma.groupSession.createMany({ data: sessions12 })
  }

  return c.json({ success: true, data: { id: gc.id } }, 201)
})

// PATCH /api/v1/group-classes/:id
groupClasses.patch('/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { name, venue, ntrpRange, capacity, description, status } = await c.req.json()
  await prisma.groupClass.update({
    where: { id: c.req.param('id') },
    data: { name, venue, ntrpRange, capacity: capacity != null ? Number(capacity) : undefined, description, status },
  })
  return c.json({ success: true, data: { message: '更新成功' } })
})

// GET /api/v1/group-classes/:id/sessions
groupClasses.get('/:id/sessions', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  const sessions = await prisma.groupSession.findMany({
    where: { classId: c.req.param('id') },
    include: { attendances: { where: { studentId: userId } } },
    orderBy: { startTime: 'asc' },
  })
  return c.json({
    success: true,
    data: sessions.map((s) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      venue: s.venue,
      isCompleted: s.isCompleted,
      myAttendance: s.attendances[0] ?? null,
    })),
  })
})

// POST /api/v1/group-classes/:id/enroll — 学员报名
groupClasses.post('/:id/enroll', authMiddleware, requireRole(Role.STUDENT), async (c) => {
  const { userId: studentId } = c.get('user')
  const { packageId } = await c.req.json()
  const classId = c.req.param('id')

  // 在事务中检查容量并创建报名（防止并发超额）
  const result = await prisma.$transaction(async (tx) => {
    const gcLocked = await tx.groupClass.findUnique({
      where: { id: classId },
      include: { _count: { select: { enrollments: true } } },
    })
    if (!gcLocked) throw new Error('班级不存在')
    if (gcLocked._count.enrollments >= gcLocked.capacity) throw new Error('名额已满')

    const dup = await tx.groupEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
    })
    if (dup) throw new Error('已报名该班级')

    return tx.groupEnrollment.create({
      data: { classId, studentId, packageId, status: BookingStatus.PENDING },
    })
  }).catch((e: Error) => {
    const known = ['班级不存在', '名额已满', '已报名该班级']
    if (known.includes(e.message)) return e.message
    throw e
  })

  if (typeof result === 'string') {
    const code = result === '班级不存在' ? 404 : 409
    return c.json({ success: false, error: result }, code)
  }
  return c.json({ success: true, data: { message: '报名成功，等待教练确认' } }, 201)
})

// POST /api/v1/group-sessions/:id/attendance — 出勤核销
groupClasses.post('/sessions/:id/attendance', authMiddleware, requireRole(Role.COACH, Role.ADMIN), async (c) => {
  const { userId: operatorId } = c.get('user')
  const sessionId = c.req.param('id')
  const { attendances } = await c.req.json() // [{ studentId, attended }]

  const session = await prisma.groupSession.findUnique({ where: { id: sessionId } })
  if (!session) return c.json({ success: false, error: '课次不存在' }, 404)

  for (const a of attendances) {
    const existing = await prisma.groupAttendance.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: a.studentId } },
    })
    if (existing) continue

    // 在事务中原子写入出勤记录和课时核销
    await prisma.$transaction(async (tx) => {
      await tx.groupAttendance.create({ data: { sessionId, studentId: a.studentId, attended: a.attended, operatorId } })

      if (a.attended) {
        const enrollment = await tx.groupEnrollment.findUnique({
          where: { classId_studentId: { classId: session.classId, studentId: a.studentId } },
        })
        if (enrollment?.packageId) {
          const pkg = await tx.studentPackage.findFirst({
            where: { id: enrollment.packageId, endDate: { gt: new Date() } },
          })
          if (pkg && pkg.usedLessons < pkg.totalLessons) {
            await tx.studentPackage.update({ where: { id: pkg.id }, data: { usedLessons: { increment: 1 } } })
            await tx.lessonConsumption.create({ data: { packageId: pkg.id, sessionId, operatorId } })
          }
        }
      }
    })
  }

  await prisma.groupSession.update({ where: { id: sessionId }, data: { isCompleted: true } })
  return c.json({ success: true, data: { message: '核销完成' } })
})

// DELETE /api/v1/group-sessions/:id/attendance/:studentId — 撤销（仅管理员）
groupClasses.delete('/sessions/:id/attendance/:studentId', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const sessionId = c.req.param('id')
  const studentId = c.req.param('studentId')

  const attendance = await prisma.groupAttendance.findUnique({
    where: { sessionId_studentId: { sessionId, studentId } },
  })
  if (!attendance) return c.json({ success: false, error: '记录不存在' }, 404)

  // 退课时
  if (attendance.attended) {
    const consumption = await prisma.lessonConsumption.findFirst({ where: { sessionId } })
    if (consumption) {
      await prisma.studentPackage.update({ where: { id: consumption.packageId }, data: { usedLessons: { decrement: 1 } } })
      await prisma.lessonConsumption.delete({ where: { id: consumption.id } })
    }
  }

  await prisma.groupAttendance.delete({ where: { sessionId_studentId: { sessionId, studentId } } })

  // 检查课次是否还有其他出勤记录
  const remaining = await prisma.groupAttendance.count({ where: { sessionId } })
  if (remaining === 0) {
    await prisma.groupSession.update({ where: { id: sessionId }, data: { isCompleted: false } })
  }

  return c.json({ success: true, data: { message: '已撤销' } })
})

export default groupClasses
