import { AbilityClass, PureAbility } from '@casl/ability';
import type { MongoQuery } from '@casl/ability';

// Re-export so consumers tag Prisma plain objects without a direct @casl/ability import
export { subject } from '@casl/ability';

// =============================================================================
// Actions
// =============================================================================

export type Action =
  | 'manage'      // wildcard — implies every action on a subject
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'submit'      // LeaveRequest: DRAFT → PENDING_APPROVAL
  | 'approve'     // LeaveRequest: supervisor approval or final approval
  | 'reject'      // LeaveRequest: any active state → REJECTED
  | 'cancel'      // LeaveRequest: DRAFT | PENDING_APPROVAL | APPROVED_BY_SUPERVISOR → CANCELLED
  | 'analyze';    // BusinessIntelligence: AI-driven divisional health analytics (HR Director +)

// =============================================================================
// Subjects
//
// WHY string literals instead of InferSubjects<typeof PrismaModel>:
//   CASL's InferSubjects() expects class constructors (TypeORM/MikroORM style).
//   Prisma generates TypeScript interfaces — they have no runtime constructor,
//   so InferSubjects silently produces `never`, breaking detectSubjectType.
//   String literals are the correct approach for Prisma.
//
// HOW to check against an actual Prisma object (e.g., for condition matching):
//   import { subject } from './casl.types';
//   ability.can('update', subject('LeaveRequest', leaveRequest));
//   The subject() helper tags the object so detectSubjectType can identify it.
// =============================================================================

export type SubjectName =
  | 'User'
  | 'Unit'
  | 'Role'
  | 'Permission'
  | 'LeaveRequest'
  | 'LeaveApproval'
  | 'BusinessIntelligence'  // virtual subject for AI analytics endpoints — no DB model
  | 'all';

// =============================================================================
// AppAbility
//
// PureAbility<[Action, SubjectName], MongoQuery>:
//   - PureAbility  : the generic CASL ability (no MongoDB assumed)
//   - [Action, SubjectName] : our typed tuple of what can be done to what
//   - MongoQuery   : conditions language (e.g. { userId: 'abc' }, { $in: [...] })
//                    MongoAbility<T> is just an alias for PureAbility<T, MongoQuery>,
//                    so using PureAbility explicitly makes the conditions type visible.
// =============================================================================

export type AppAbility = PureAbility<[Action, SubjectName], MongoQuery>;

// The const form is used for NestJS DI when you want to @InjectAbility() in a service.
// Keep this export even if not used yet — it costs nothing and enables clean DI later.
export const AppAbility = PureAbility as AbilityClass<AppAbility>;
