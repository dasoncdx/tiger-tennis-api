import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role } from '@prisma/client'

const notes = new Hono()

// GET /api/v1/training-notes/:studentId
notes.get('/training-notes/:studentId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const studentId = c.req.param('studentId')
  if (role === Role.STUDENT && userId !== studentId) return c.json({ success: false, error: '无权限' }, 403)
  const list = await prisma.trainingNote.findMany({
    where: { studentId },
    include: { coach: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: list })
})

// POST /api/v1/training-notes
notes.post('/training-notes', authMiddleware, requireRole(Role.COACH), async (c) => {
  const { userId: coachId } = c.get('user')
  const { studentId, bookingId, content, improvement } = await c.req.json()
  if (!studentId || !content) return c.json({ success: false, error: '缺少必填字段' }, 400)
  const note = await prisma.trainingNote.create({ data: { studentId, coachId, bookingId, content, improvement } })
  return c.json({ success: true, data: { id: note.id } }, 201)
})

// GET /api/v1/monthly-reports/:studentId
notes.get('/monthly-reports/:studentId', authMiddleware, async (c) => {
  const { userId, role } = c.get('user')
  const studentId = c.req.param('studentId')
  if (role === Role.STUDENT && userId !== studentId) return c.json({ success: false, error: '无权限' }, 403)
  const list = await prisma.monthlyReport.findMany({
    where: { studentId },
    include: { coach: { select: { name: true } } },
    orderBy: { month: 'desc' },
  })
  return c.json({ success: true, data: list })
})

// POST /api/v1/monthly-reports
notes.post('/monthly-reports', authMiddleware, requireRole(Role.COACH), async (c) => {
  const { userId: coachId } = c.get('user')
  const { studentId, goodPoints, improvement, suggestion } = await c.req.json()
  if (!studentId || !goodPoints || !improvement || !suggestion) return c.json({ success: false, error: '缺少必填字段' }, 400)
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const existing = await prisma.monthlyReport.findUnique({ where: { studentId_coachId_month: { studentId, coachId, month } } })
  if (existing) return c.json({ success: false, error: '本月已发布过反馈' }, 409)

  const report = await prisma.monthlyReport.create({ data: { studentId, coachId, month, goodPoints, improvement, suggestion } })
  await prisma.notification.create({
    data: { userId: studentId, type: 'FEEDBACK', title: '教练发布了本月反馈', content: '您的教练发布了本月训练反馈，请查看' },
  })
  return c.json({ success: true, data: { id: report.id } }, 201)
})

export default notes
