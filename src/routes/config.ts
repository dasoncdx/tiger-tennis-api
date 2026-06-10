import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireRole } from '../middleware/auth'
import { Role } from '@prisma/client'

const config = new Hono()

// GET /api/v1/config/site
config.get('/site', async (c) => {
  const keys = ['site_name', 'site_intro', 'site_phone', 'site_address']
  const configs = await prisma.siteConfig.findMany({ where: { key: { in: keys } } })
  const result: Record<string, string> = {}
  configs.forEach((c) => { result[c.key] = c.value })
  return c.json({ success: true, data: result })
})

// PUT /api/v1/config/site
config.put('/site', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const body = await c.req.json()
  await Promise.all(
    Object.entries(body).map(([key, value]) =>
      prisma.siteConfig.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    )
  )
  return c.json({ success: true, data: { message: '保存成功' } })
})

// GET /api/v1/config/banners
config.get('/banners', async (c) => {
  const banners = await prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } })
  return c.json({ success: true, data: banners })
})

// POST /api/v1/config/banners
config.post('/banners', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { imageUrl, sortOrder } = await c.req.json()
  const count = await prisma.banner.count()
  if (count >= 5) return c.json({ success: false, error: 'Banner最多5张' }, 400)
  const b = await prisma.banner.create({ data: { imageUrl, sortOrder: sortOrder ?? count } })
  return c.json({ success: true, data: { id: b.id } }, 201)
})

// DELETE /api/v1/config/banners/:id
config.delete('/banners/:id', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  await prisma.banner.delete({ where: { id: c.req.param('id') } })
  return c.json({ success: true, data: { message: '已删除' } })
})

// PATCH /api/v1/config/banners/sort
config.patch('/banners/sort', authMiddleware, requireRole(Role.ADMIN), async (c) => {
  const { ids } = await c.req.json() // 按新顺序排列的id数组
  await Promise.all(ids.map((id: string, index: number) =>
    prisma.banner.update({ where: { id }, data: { sortOrder: index } })
  ))
  return c.json({ success: true, data: { message: '排序已更新' } })
})

export default config
