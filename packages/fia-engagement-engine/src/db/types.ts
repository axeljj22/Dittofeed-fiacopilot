/**
 * Types matching FIA Copilot's Supabase schema.
 * Read-only — the engine never modifies these tables (except engagement_log).
 */

export interface Profile {
  id: string;
  nombre: string;
  empresa: string;
  industria: string;
  objetivo: string;
  whatsapp: string | null;
  wp_opted_out: boolean;
  plan: string;
  rol: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface Capsule {
  id: string;
  numero: number;
  titulo: string;
  contenido: string;
  mini_accion: string;
  deliverable: string;
  worker_slug: string;
}

export interface CapsuleProgress {
  id: string;
  user_id: string;
  capsule_id: string;
  capsule_numero: number;
  status: "not_started" | "started" | "in_progress" | "completed";
  updated_at: string;
}

export interface VaultOutput {
  id: string;
  user_id: string;
  content_type: string;
  capsule_numero: number;
  context_business: string | null;
  context_personal: string | null;
  context_ai_memory: string | null;
  content: string;
  created_at: string;
}

export interface AssessmentSubmission {
  id: string;
  user_id: string;
  responses: Record<string, unknown>;
  created_at: string;
}

export interface LeadScore {
  id: string;
  user_id: string;
  fit_score: number;
  intent_score: number;
  overall_score: number;
  updated_at: string;
}

export interface UserEvent {
  id: string;
  user_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ─── Write-only table ───

export interface EngagementLogInsert {
  user_id: string;
  journey_name: string;
  mensaje_enviado: string;
  whatsapp_number: string;
  deep_link: string;
  status: "sent" | "failed" | "opted_out";
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
