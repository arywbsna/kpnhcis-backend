import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AuthModule } from '../../auth/auth.module';
import { CaslModule } from '../../casl/casl.module';
import { ATTENDANCE_QUEUE } from './queues/attendance.queue';
import { AttendanceManagementController } from './attendance-management.controller';
import { LeaveManagementController } from './leave-management.controller';
import { AttendanceManagementService } from './attendance-management.service';
import { LeaveManagementService } from './leave-management.service';

/**
 * TimeManagementModule — Attendance & Leave sub-modules for the enterprise HCIS.
 *
 * ─── Sub-modules ──────────────────────────────────────────────────────────────
 *   Attendance API (5 endpoints):
 *     POST /attendance/attendanceAPI/GetAttendanceDetails
 *     POST /attendance/attendanceAPI/GetAttendancePoliciesDetails
 *     POST /attendance/attendanceAPI/GetAttendanceOverview
 *     POST /attendance/attendanceAPI/getDayStatus
 *     POST /attendance/attendanceAPI/GetAttendanceLog
 *
 *   Leaves API (5 endpoints):
 *     POST /leaves/leavesApi/GetLeaveCommonDetails
 *     POST /leaves/leavesApi/getUpcomingTimeOff
 *     POST /leaves/leavesApi/getTeamStatus
 *     POST /leaves/leavesApi/GetDataForLeavePattern
 *     POST /leaves/leavesApi/GetLeaves
 *
 * ─── BullMQ ───────────────────────────────────────────────────────────────────
 *   Registers the "attendance" queue.  The root BullModule.forRootAsync()
 *   in AppModule owns the Redis connection; forFeature() here only declares
 *   which named queue this module's services can inject.
 *
 *   Processors are intentionally NOT registered here — they live in a
 *   dedicated worker process that imports only the processor class and the
 *   queue name, keeping the HTTP server memory footprint lean.
 *
 * ─── Dependencies ─────────────────────────────────────────────────────────────
 *   AuthModule   — provides JwtAuthGuard (via @nestjs/passport JWT strategy).
 *   CaslModule   — provides PermissionsGuard + CaslAbilityFactory.
 *   PrismaModule — satisfied globally (AppModule registers it with @Global()).
 *   CacheModule  — satisfied globally (used by CaslAbilityFactory internally).
 */
@Module({
  imports: [
    AuthModule,
    CaslModule,
    BullModule.registerQueue({ name: ATTENDANCE_QUEUE }),
  ],
  controllers: [
    AttendanceManagementController,
    LeaveManagementController,
  ],
  providers: [
    AttendanceManagementService,
    LeaveManagementService,
  ],
  exports: [
    AttendanceManagementService,
    LeaveManagementService,
  ],
})
export class TimeManagementModule {}
