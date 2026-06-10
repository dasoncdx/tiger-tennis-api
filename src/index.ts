import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import authRoutes from './routes/auth'
import usersRoutes from './routes/users'
import ntrpRoutes from './routes/ntrp'
import packagesRoutes from './routes/packages'
import bookingsRoutes from './routes/bookings'
import groupClassesRoutes from './routes/groupClasses'
import tournamentsRoutes from './routes/tournaments'
import notificationsRoutes from './routes/notifications'
import notesRoutes from './routes/notes'
import configRoutes from './routes/config'

const app = new Hono()

app.use('*', logger())
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'] }))

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

app.route('/api/v1/auth', authRoutes)
app.route('/api/v1/users', usersRoutes)
app.route('/api/v1/ntrp', ntrpRoutes)
app.route('/api/v1/packages', packagesRoutes)
app.route('/api/v1/bookings', bookingsRoutes)
app.route('/api/v1/group-classes', groupClassesRoutes)
app.route('/api/v1/tournaments', tournamentsRoutes)
app.route('/api/v1/notifications', notificationsRoutes)
app.route('/api/v1', notesRoutes)
app.route('/api/v1/config', configRoutes)

const port = Number(process.env.PORT) || 3001
console.log(`🎾 Tiger Tennis API running on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
