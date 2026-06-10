import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role } from '@prisma/client'

const tournaments = new Hono()

// GET /api/v1/tournaments
tournaments.get('/', async (c) => {
  const { status } = c.req.query()
  const where = status ? { status: status as any } : {}
  const list = await prisma.tournament.findMany({
    where,
    include: { _count: { select: { entries: true } } },
    orderBy: { eventDate: 'asc' },
  })
  return c.json({ success: true, data: list.map((t) => ({ ...t, enrolledCount: t._count.entries })) })
})

// POST /api/v1/tournaments
tournaments.post('/', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  const { name, eventDate, registrationDeadline, capacity, rules, grouping, coverUrl, status } = body
  const t = await prisma.tournament.create({
    data: { name, eventDate: new Date(eventDate), registrationDeadline: new Date(registrationDeadline), capacity: Number(capacity), rules, grouping, coverUrl, status: status || 'DRAFT' },
  })
  return c.json({ success: true, data: { id: t.id } }, 201)
})

// PATCH /api/v1/tournaments/:id
tournaments.patch('/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  const { name, eventDate, registrationDeadline, capacity, rules, grouping, coverUrl, status } = body
  await prisma.tournament.update({
    where: { id: c.req.param('id') },
    data: { name, eventDate: eventDate ? new Date(eventDate) : undefined, registrationDeadline: registrationDeadline ? new Date(registrationDeadline) : undefined, capacity: capacity ? Number(capacity) : undefined, rules, grouping, coverUrl, status },
  })
  return c.json({ success: true, data: { message: '更新成功' } })
})

// GET /api/v1/tournaments/:id/entries
tournaments.get('/:id/entries', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId: c.req.param('id') },
    include: { student: { select: { name: true, phone: true } }, awards: { include: { award: true } }, diagnosisCard: true },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({ success: true, data: entries })
})

// POST /api/v1/tournaments/:id/entries — 学员报名
tournaments.post('/:id/entries', authMiddleware, requireRole(Role.STUDENT), async (c) => {
  const { userId: studentId } = c.get('user')
  const tournamentId = c.req.param('id')

  const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, include: { _count: { select: { entries: true } } } })
  if (!t) return c.json({ success: false, error: '赛事不存在' }, 404)
  if (t.status !== 'PUBLISHED') return c.json({ success: false, error: '赛事不在报名中' }, 400)
  if (new Date() > t.registrationDeadline) return c.json({ success: false, error: '报名已截止' }, 400)
  if (t._count.entries >= t.capacity) return c.json({ success: false, error: '名额已满' }, 409)

  const existing = await prisma.tournamentEntry.findUnique({ where: { tournamentId_studentId: { tournamentId, studentId } } })
  if (existing) return c.json({ success: false, error: '已报名该赛事' }, 409)

  // 获取当前段位快照
  const latestApproved = await prisma.ntrpApplication.findFirst({
    where: { studentId, status: 'APPROVED' },
    orderBy: { reviewedAt: 'desc' },
  })

  // 在事务中检查容量并创建报名（防止并发超额）
  const entry = await prisma.$transaction(async (tx) => {
    const tLocked = await tx.tournament.findUnique({
      where: { id: tournamentId },
      include: { _count: { select: { entries: true } } },
    })
    if (!tLocked || tLocked._count.entries >= tLocked.capacity) throw new Error('名额已满')

    const dup = await tx.tournamentEntry.findUnique({ where: { tournamentId_studentId: { tournamentId, studentId } } })
    if (dup) throw new Error('已报名该赛事')

    return tx.tournamentEntry.create({
      data: { tournamentId, studentId, ntrpSnapshot: latestApproved?.toLevel ?? 'LEVEL_2_5B' },
    })
  }).catch((e: Error) => {
    if (['名额已满', '已报名该赛事'].includes(e.message)) return e.message
    throw e
  })

  if (typeof entry === 'string') {
    return c.json({ success: false, error: entry }, 409)
  }

  await prisma.notification.create({
    data: { userId: studentId, type: 'TOURNAMENT', title: '报名成功', content: `您已成功报名 ${t.name}` },
  })

  return c.json({ success: true, data: { id: entry.id } }, 201)
})

// DELETE /api/v1/tournaments/:id/entries/:entryId
tournaments.delete('/:id/entries/:entryId', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  await prisma.tournamentEntry.delete({ where: { id: c.req.param('entryId') } })
  return c.json({ success: true, data: { message: '已取消报名' } })
})

// PATCH /api/v1/tournaments/:id/entries/:entryId/result
tournaments.patch('/:id/entries/:entryId/result', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { ranking, awardIds } = await c.req.json()
  await prisma.tournamentEntry.update({ where: { id: c.req.param('entryId') }, data: { ranking } })
  if (awardIds?.length) {
    await prisma.tournamentEntryAward.deleteMany({ where: { entryId: c.req.param('entryId') } })
    await prisma.tournamentEntryAward.createMany({
      data: awardIds.map((awardId: string) => ({ entryId: c.req.param('entryId'), awardId })),
    })
  }
  return c.json({ success: true, data: { message: '成绩已录入' } })
})

// POST /api/v1/tournaments/:id/diagnosis — 填写/更新诊断卡
tournaments.post('/:id/diagnosis', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { entryId, goodPoint1, goodPoint2, improvement, suggestion } = await c.req.json()
  await prisma.diagnosisCard.upsert({
    where: { entryId },
    update: { goodPoint1, goodPoint2, improvement, suggestion },
    create: { entryId, goodPoint1, goodPoint2, improvement, suggestion },
  })
  return c.json({ success: true, data: { message: '诊断卡已保存' } })
})

// POST /api/v1/tournaments/:id/diagnosis/send
tournaments.post('/:id/diagnosis/send', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { entryIds } = await c.req.json() // 支持单个或批量
  const entries = await prisma.tournamentEntry.findMany({
    where: { id: { in: entryIds }, diagnosisCard: { isNot: null } },
    include: { diagnosisCard: true },
  })
  await Promise.all(entries.map(async (entry) => {
    await prisma.diagnosisCard.update({ where: { entryId: entry.id }, data: { sentAt: new Date() } })
    await prisma.notification.create({
      data: { userId: entry.studentId, type: 'TOURNAMENT', title: '赛事诊断卡已发布', content: '您的赛事诊断卡已发布，请查看' },
    })
  }))
  return c.json({ success: true, data: { message: `已发送 ${entries.length} 份诊断卡` } })
})

export default tournaments
