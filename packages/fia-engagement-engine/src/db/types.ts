/**
 * Types matching FIA Copilot's real Supabase schema.
 * Read-only — the engine never modifies these tables (except engagement_log).
 */

export interface Profile {
  id: string;
  name: string | null;
  email: string;
  company_name: string | null;
  industry: string | null;
  objective: string | null;
  role: string | null;          // laboral role (e.g. "Director Comercial")
  org_role: string | null;      // program role: 'sponsor' | 'implementador' | 'referente'
  phone: string | null;         // used as WhatsApp number
  whatsapp_opt_in: boolean;     // true = user accepts WA messages
  sofia_activated_at: string | null; // set when user confirms Sofía activation; null = not active / deactivated
  sofia_deactivated_at: string | null; // set on STOP; front shows "diste de baja por WhatsApp"
  temperature: string | null;   // CRM label: 'frio' | 'tibio' | 'caliente'
  country: string | null;
  is_admin: boolean;
  is_coach: boolean;
  onboarding_completed: boolean;
  content_unlocked: boolean;
  preferences: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Capsule {
  id: string;
  number: number;
  title: string;
  content_md: string | null;
  mini_action: string | null;
  deliverable: string | null;
  slug: string;
  path_id: string | null;
  week: number | null;
}

export interface CapsuleProgress {
  id: string;
  lead_id: string;
  capsule_id: string;
  capsule_number: number;       // joined from capsules.number
  capsule_title: string | null; // joined from capsules.title
  status: "not_started" | "viewed" | "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  video_watched: boolean;
  path_id: string | null;
}

export interface VaultOutput {
  id: string;
  lead_id: string;
  capsule_id: string | null;
  content_type: string;         // 'context_business' | 'context_personal' | 'context_ai_memory' | 'text' | 'ai_response' | etc.
  content: string;
  title: string | null;
  created_at: string;
}

export interface AssessmentSubmission {
  id: string;
  lead_id: string;
  assessment_id: string;
  answers: Record<string, unknown>;
  score: number;
  max_score: number;
  pain_areas: string[];
  recommended_capsules: number[] | null;
  created_at: string;
}

export interface LeadScore {
  id: string;
  lead_id: string;
  fit_score: number;
  intent_score: number;
  overall_score: number;
  last_calculated_at: string;
}

export interface UserEvent {
  id: string;
  lead_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  status: string;               // 'active' | 'trialing' | 'canceled' | etc.
  plan_id: string | null;
  created_at: string;
}

export interface UserProgramAccess {
  id: string;
  user_id: string;
  status: string;               // 'active' | 'expired' | etc.
  created_at: string;
}

export interface LearningPath {
  id: string;
  name: string;
  program_slug: string | null;  // null = free method (Método FIA); matches user_program_access.program_slug
  is_paid: boolean;
  display_order: number;
  is_active: boolean;
}

export interface UserPathStatus {
  pathId: string;
  name: string;
  programSlug: string | null;
  isPaid: boolean;
  completed: number;
  total: number;
  nextCapsuleNumber: number | null;
  nextCapsuleTitle: string | null;
  isFinished: boolean;
  activePath: boolean;
}

// ─── Write-only table ───

export interface EngagementLogInsert {
  lead_id: string;
  status: "sent" | "failed" | "opted_out" | "skipped_paused" | "failed_pending_retry";
  message: string;
  channel: string; // 'whatsapp'
  trigger_type: string; // 'weekly_report' | 'inbound_reply' | 'manual' | 'activation'
  metadata: {
    journey_name: string;
    whatsapp_number: string;
    deep_link: string;
    paused_until?: string; // ISO timestamp if status === 'skipped_paused'
    retry_count?: number; // # of attempts if status === 'failed_pending_retry'
    last_retry_at?: string; // ISO timestamp of last retry
    last_error?: string; // last error message
    responded?: boolean; // user replied to this message
    response_text?: string; // text of the user's reply
    recovered?: boolean; // a failed message succeeded on retry
    [key: string]: unknown; // forward-compatible extra fields
  };
}

export interface EngagementLog extends EngagementLogInsert {
  id: string;
  created_at: string;
}

// ─── Detector output ───

/** Only one journey remains: the personalized weekly report. */
export type JourneyName = "reporte_semanal";

export interface EngagementOpportunity {
  userId: string;
  journeyName: JourneyName;
  profile: Profile;
  /** Context data for the weekly report (recap + next action, see weeklyReport detector) */
  context: Record<string, unknown>;
  deepLink: string;
}
