import { PrismaClient, Role, AccountStatus, NtrpLevel, CourseType, GroupClassType, BookingStatus } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import * as dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function main() {
  const hash = (pwd: string) => bcrypt.hashSync(pwd, 10)

  // ─── 管理员 ───────────────────────────────
  const admin = await prisma.user.upsert({
    where: { phone: '13800000001' },
    update: {},
    create: {
      name: '超级管理员',
      phone: '13800000001',
      password: hash('123'),
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
    },
  })

  // ─── 教练 ─────────────────────────────────
  const coach1 = await prisma.user.upsert({
    where: { phone: '13800000002' },
    update: {},
    create: {
      name: '黄教练',
      phone: '13800000002',
      password: hash('123'),
      role: Role.COACH,
      status: AccountStatus.ACTIVE,
      coachProfile: {
        create: {
          specialty: '正手专项',
          bio: '从事网球教学10年，擅长正手技术指导',
          yearsExp: 10,
          privateRate: 150,
          groupRate: 80,
        },
      },
    },
  })

  const coach2 = await prisma.user.upsert({
    where: { phone: '13800000003' },
    update: {},
    create: {
      name: '李教练',
      phone: '13800000003',
      password: hash('123'),
      role: Role.COACH,
      status: AccountStatus.ACTIVE,
      coachProfile: {
        create: {
          specialty: '发球专项',
          bio: '国家一级运动员，专攻发球技术',
          yearsExp: 8,
          privateRate: 140,
          groupRate: 75,
        },
      },
    },
  })

  // ─── 学员 ─────────────────────────────────
  const student1 = await prisma.user.upsert({
    where: { phone: '13800000010' },
    update: {},
    create: {
      name: '张同学',
      phone: '13800000010',
      password: hash('123'),
      role: Role.STUDENT,
      status: AccountStatus.ACTIVE,
    },
  })

  const student2 = await prisma.user.upsert({
    where: { phone: '13800000011' },
    update: {},
    create: {
      name: '小明同学',
      phone: '13800000011',
      password: hash('123'),
      role: Role.STUDENT,
      status: AccountStatus.ACTIVE,
      remark: '青少年学员，家长手机号',
    },
  })

  await prisma.user.upsert({
    where: { phone: '13800000012' },
    update: {},
    create: {
      name: '待审批用户',
      phone: '13800000012',
      password: hash('123'),
      role: Role.STUDENT,
      status: AccountStatus.PENDING,
      remark: '用于测试审批流程',
    },
  })

  // ─── 机构配置 ─────────────────────────────
  await prisma.siteConfig.upsert({
    where: { key: 'site_name' },
    update: {},
    create: { key: 'site_name', value: 'Tiger网球俱乐部' },
  })
  await prisma.siteConfig.upsert({
    where: { key: 'site_intro' },
    update: {},
    create: { key: 'site_intro', value: '广州专业网球培训机构，专注提升每位学员的网球水平' },
  })
  await prisma.siteConfig.upsert({
    where: { key: 'site_phone' },
    update: {},
    create: { key: 'site_phone', value: '020-12345678' },
  })
  await prisma.siteConfig.upsert({
    where: { key: 'site_address' },
    update: {},
    create: { key: 'site_address', value: '广州市天河区某某网球中心' },
  })

  // ─── 套餐模板 ─────────────────────────────
  const privateTpl = await prisma.coursePackageTemplate.upsert({
    where: { id: 'tpl-private-10' },
    update: {},
    create: {
      id: 'tpl-private-10',
      name: '私教10节卡',
      type: CourseType.PRIVATE,
      totalLessons: 10,
      price: 1500,
      validDays: 90,
      isActive: true,
    },
  })

  const groupTpl = await prisma.coursePackageTemplate.upsert({
    where: { id: 'tpl-group-20' },
    update: {},
    create: {
      id: 'tpl-group-20',
      name: '进阶团课20节',
      type: CourseType.GROUP,
      totalLessons: 20,
      price: 800,
      validDays: 180,
      isActive: true,
    },
  })

  // ─── 学员套餐 ─────────────────────────────
  const now = new Date()
  const pkg1 = await prisma.studentPackage.upsert({
    where: { id: 'pkg-s1-private' },
    update: {},
    create: {
      id: 'pkg-s1-private',
      studentId: student1.id,
      templateId: privateTpl.id,
      type: CourseType.PRIVATE,
      totalLessons: 10,
      usedLessons: 3,
      startDate: now,
      endDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    },
  })

  await prisma.studentPackage.upsert({
    where: { id: 'pkg-s2-group' },
    update: {},
    create: {
      id: 'pkg-s2-group',
      studentId: student2.id,
      templateId: groupTpl.id,
      type: CourseType.GROUP,
      totalLessons: 20,
      usedLessons: 5,
      startDate: now,
      endDate: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
    },
  })

  // ─── 教练开放时段 ─────────────────────────
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(14, 0, 0, 0)
  const tomorrowEnd = new Date(tomorrow)
  tomorrowEnd.setHours(15, 0, 0, 0)

  const dayAfter = new Date(now)
  dayAfter.setDate(dayAfter.getDate() + 2)
  dayAfter.setHours(10, 0, 0, 0)
  const dayAfterEnd = new Date(dayAfter)
  dayAfterEnd.setHours(11, 0, 0, 0)

  await prisma.coachSchedule.createMany({
    skipDuplicates: true,
    data: [
      { coachId: coach1.id, startTime: tomorrow, endTime: tomorrowEnd, isRecurring: false },
      { coachId: coach1.id, startTime: dayAfter, endTime: dayAfterEnd, isRecurring: false },
      { coachId: coach2.id, startTime: dayAfter, endTime: dayAfterEnd, isRecurring: false },
    ],
  })

  // ─── 私教预约记录 ─────────────────────────
  const booking1 = await prisma.booking.upsert({
    where: { id: 'booking-test-1' },
    update: {},
    create: {
      id: 'booking-test-1',
      studentId: student1.id,
      coachId: coach1.id,
      startTime: tomorrow,
      endTime: tomorrowEnd,
      venue: '1号球场',
      status: BookingStatus.CONFIRMED,
    },
  })

  // ─── 段位记录 ─────────────────────────────
  const ntrpRecord = await prisma.ntrpRecord.upsert({
    where: { id: 'ntrp-s1-1' },
    update: {},
    create: {
      id: 'ntrp-s1-1',
      studentId: student1.id,
      coachId: coach1.id,
      forehand: 3,
      backhand: 2,
      serve: 3,
      movement: 3,
      tactics: 2,
      remark: '正手进步明显，反手需加强',
      applyPromotion: true,
    },
  })

  await prisma.ntrpApplication.upsert({
    where: { id: 'ntrp-app-1' },
    update: {},
    create: {
      id: 'ntrp-app-1',
      studentId: student1.id,
      recordId: ntrpRecord.id,
      fromLevel: NtrpLevel.LEVEL_2_5A,
      toLevel: NtrpLevel.LEVEL_3_0B,
      status: 'PENDING',
    },
  })

  // ─── 团课班级 ─────────────────────────────
  const groupClass = await prisma.groupClass.upsert({
    where: { id: 'class-30-wed' },
    update: {},
    create: {
      id: 'class-30-wed',
      name: '3.0进阶班-周三',
      coachId: coach1.id,
      classType: GroupClassType.RECURRING,
      ntrpRange: '3.0-3.5',
      capacity: 8,
      lessonsPerSession: 1,
      description: '适合3.0-3.5段位的进阶学员，每周三晚上固定课程',
      weekday: 3,
      startTimeStr: '19:00',
      endTimeStr: '20:30',
      effectiveFrom: now,
    },
  })

  // 生成未来4周的课次
  for (let i = 0; i < 4; i++) {
    const sessionDate = new Date(now)
    // 找下一个周三
    const daysUntilWed = (3 - sessionDate.getDay() + 7) % 7 || 7
    sessionDate.setDate(sessionDate.getDate() + daysUntilWed + i * 7)
    sessionDate.setHours(19, 0, 0, 0)
    const sessionEnd = new Date(sessionDate)
    sessionEnd.setHours(20, 30, 0, 0)

    await prisma.groupSession.upsert({
      where: { id: `session-wed-${i}` },
      update: {},
      create: {
        id: `session-wed-${i}`,
        classId: groupClass.id,
        startTime: sessionDate,
        endTime: sessionEnd,
      },
    })
  }

  // 学员2加入团课
  await prisma.groupEnrollment.upsert({
    where: { classId_studentId: { classId: groupClass.id, studentId: student2.id } },
    update: {},
    create: {
      classId: groupClass.id,
      studentId: student2.id,
      packageId: 'pkg-s2-group',
      status: BookingStatus.CONFIRMED,
    },
  })

  // ─── 赛事 ─────────────────────────────────
  const eventDate = new Date(now)
  eventDate.setDate(eventDate.getDate() + 30)
  const deadline = new Date(now)
  deadline.setDate(deadline.getDate() + 20)

  await prisma.tournament.upsert({
    where: { id: 'tournament-1' },
    update: {},
    create: {
      id: 'tournament-1',
      name: 'Tiger杯第一届段位挑战赛',
      eventDate,
      registrationDeadline: deadline,
      capacity: 32,
      rules: '分组循环赛+单淘汰决赛，按NTRP段位分组',
      grouping: '2.5组、3.0组、3.5组各独立比赛',
      status: 'PUBLISHED',
    },
  })

  // ─── 月度反馈 ─────────────────────────────
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  await prisma.monthlyReport.upsert({
    where: { studentId_coachId_month: { studentId: student1.id, coachId: coach1.id, month: currentMonth } },
    update: {},
    create: {
      studentId: student1.id,
      coachId: coach1.id,
      month: currentMonth,
      goodPoints: '本月正手稳定性明显提升，对打可以维持20拍以上',
      improvement: '反手力量不足，容易被对方调动',
      suggestion: '下月重点练习反手发力，建议每次训练加入30分钟反手专项',
    },
  })

  console.log('✅ Seed 完成')
  console.log('管理员: 13800000001 / 123')
  console.log('教练A: 13800000002 / 123')
  console.log('教练B: 13800000003 / 123')
  console.log('学员A: 13800000010 / 123')
  console.log('学员B: 13800000011 / 123')
  console.log('待审批: 13800000012 / 123')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
