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
  temperature: string | null;   // CRM label: 'frio' | 'tibio' | 'caliente'
  is_admin: boolean;
  is_coach: boolean;
  onboarding_completed: boolean;
  content_unlocked: boolean;
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

// ─── Write-only table ───

export interface EngagementLogInsert {
  user_id: string;
  journey_name: string;
  mensaje_enviado: string;
  whatsapp_number: string;
  deep_link: string;
  status: "pending" | "sent" | "failed" | "opted_out";
  responded?: boolean;
  response_text?: string;
  clicked?: boolean;
}

export interface EngagementLog extends EngagementLogInsert {
  id: string;
  created_at: string;
}

// ─── Detector output ───

export type JourneyName =
  | "reactivacion_inactividad"
  | "celebracion_capsula"
  | "bienvenida_diagnostico"
  | "recuperacion_lead_frio"
  | "resumen_semanal_sponsor";

export interface EngagementOpportunity {
  userId: string;
  journeyName: JourneyName;
  profile: Profile;
  /** Context data specific to each journey type */
  context: Record<string, unknown>;
  deepLink: string;
  /** Level for multi-step journeys (e.g., inactivity 1/2/3) */
  level?: number;
}
