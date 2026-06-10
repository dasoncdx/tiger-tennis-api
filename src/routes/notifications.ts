import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const notifications = new Hono()

notifications.get('/', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  const list = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return c.json({ success: true, data: list })
})

notifications.get('/unread-count', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  const count = await prisma.notification.count({ where: { userId, isRead: false } })
  return c.json({ success: true, data: { count } })
})

notifications.patch('/:id/read', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  await prisma.notification.updateMany({
    where: { id: c.req.param('id'), userId },
    data: { isRead: true },
  })
  return c.json({ success: true, data: { message: '已标记已读' } })
})

notifications.patch('/read-all', authMiddleware, async (c) => {
  const { userId } = c.get('user')
  await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } })
  return c.json({ success: true, data: { message: '全部已读' } })
})

export default notifications
