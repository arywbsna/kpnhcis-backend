import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Request body for POST /ai/analytics/divisional-health.
 */
export class DivisionalHealthQueryDto {
  @IsUUID('4')
  unitId: string;

  /**
   * How many days back to include leave requests in the analysis window.
   * Defaults to 90 days when omitted.  Increase for sparse units; decrease
   * for real-time quarterly snapshots.
   */
  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(365)
  windowDays?: number;
}

// =============================================================================
// Typed shapes for the structured JSON the Qwen model returns.
// These are NOT Prisma models — they represent the AI's output contract.
// =============================================================================

export type BurnoutLevel = 'Low' | 'Medium' | 'High';
export type ImbalanceSeverity = 'None' | 'Low' | 'Medium' | 'High';

export interface BurnoutRisk {
  level: BurnoutLevel;
  score: number;          // 0.0 – 10.0
  reasoning: string;
}

export interface WorkloadImbalance {
  detected: boolean;
  severity: ImbalanceSeverity;
  signals: string[];
}

export interface SentimentOverview {
  positive_pct: number;   // 0 – 100; three values must sum to 100
  neutral_pct: number;
  negative_pct: number;
  dominant_themes: string[];
}

/**
 * The exact JSON object the Qwen model is contracted to return.
 * Used both as the parse target inside AiAnalysisService and as the
 * inner payload of DivisionalHealthReport.
 */
export interface QwenHealthAnalysis {
  burnout_risk: BurnoutRisk;
  workload_imbalance: WorkloadImbalance;
  sentiment_overview: SentimentOverview;
  team_friction_points: string[];
  recommended_actions: string[];
  confidence_score: number;   // 0.0 – 1.0
  data_quality_note: string;
}

/**
 * Full report envelope returned by the controller.
 * Wraps the AI analysis with DB-sourced metadata so clients have
 * the unit name, analysis window, and token usage without a second request.
 */
export interface DivisionalHealthReport {
  unit_id: string;
  unit_name: string;
  analysis_window_days: number;
  total_requests_analyzed: number;
  generated_at: string;           // ISO 8601
  model_used: string;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  analysis: QwenHealthAnalysis;
}
