import jwt from 'jsonwebtoken'
import { Role, AccountStatus } from '@prisma/client'

const SECRET = process.env.JWT_SECRET || 'tiger-tennis-dev-secret'

export interface JwtPayload {
  userId: string
  role: Role
  status: AccountStatus
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload
}
