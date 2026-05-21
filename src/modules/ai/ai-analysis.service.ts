import {
  GatewayTimeoutException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

import { PrismaService } from '../../prisma/prisma.service';
import {
  DivisionalHealthReport,
  QwenHealthAnalysis,
} from './dto/divisional-health.dto';

// =============================================================================
// Qwen API wire types
// =============================================================================

interface QwenMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface QwenChatRequest {
  model: string;
  messages: QwenMessage[];
  temperature: number;
  max_tokens: number;
  response_format: { type: 'json_object' };
}

interface QwenChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// =============================================================================
// Internal data shape fetched from DB
// =============================================================================

interface LeaveRequestSummary {
  id: string;
  leaveType: string;
  totalDays: number;
  reason: string;
  status: string;
  lastRemarks: string | null;
  submittedAt: Date | null;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class AiAnalysisService {
  private readonly logger = new Logger(AiAnalysisService.name);
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.model       = this.config.get<string>('QWEN_MODEL', 'qwen-plus');
    this.timeoutMs   = this.config.get<number>('QWEN_TIMEOUT_MS', 30_000);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Aggregates leave request data for every active employee in `unitId` over
   * the last `windowDays` days, anonymises the text corpus, and dispatches it
   * to the Qwen model for structured HR analysis.
   *
   * Returns a DivisionalHealthReport containing:
   *   - Burnout risk level + score + reasoning
   *   - Workload imbalance signals
   *   - Team sentiment distribution
   *   - Friction points + recommended HR interventions
   *   - Token usage for cost tracking
   */
  async analyzeDivisionalHealth(
    unitId: string,
    windowDays = 90,
  ): Promise<DivisionalHealthReport> {

    // ── 1. Validate unit ─────────────────────────────────────────────────────
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitId },
      select: { id: true, name: true, isActive: true },
    });

    if (!unit) {
      throw new NotFoundException(`Unit ${unitId} not found`);
    }

    // ── 2. Collect active user IDs in this unit ───────────────────────────
    const users = await this.prisma.user.findMany({
      where: { unitId, deletedAt: null },
      select: { id: true },
    });

    if (users.length === 0) {
      this.logger.warn(`Unit ${unitId} has no active users — returning empty report`);
      return this.buildEmptyReport(unit.id, unit.name, windowDays);
    }

    const userIds = users.map((u) => u.id);

    // ── 3. Fetch leave requests within the analysis window ────────────────
    const since = new Date();
    since.setDate(since.getDate() - windowDays);

    const raw = await this.prisma.leaveRequest.findMany({
      where: {
        userId:    { in: userIds },
        createdAt: { gte: since },
      },
      select: {
        id:          true,
        leaveType:   true,
        totalDays:   true,
        reason:      true,
        status:      true,
        payload:     true,
        submittedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (raw.length === 0) {
      this.logger.warn(
        `Unit ${unitId} has no leave requests in the last ${windowDays} days`,
      );
      return this.buildEmptyReport(unit.id, unit.name, windowDays);
    }

    if (raw.length < 3) {
      this.logger.warn(
        `Unit ${unitId} has only ${raw.length} leave request(s) — ` +
        `analysis confidence will be low`,
      );
    }

    // ── 4. Extract & anonymise text corpus ───────────────────────────────
    //
    // PII removal strategy:
    //   - Never include user IDs, names, or email addresses in the prompt.
    //   - Reference each request only by an ordinal index ([Request N]).
    //   - The `reason` and `lastRemarks` fields may contain free text written
    //     by employees; we include them verbatim but strip any remaining
    //     numeric IDs using a regex guard.
    //
    const summaries: LeaveRequestSummary[] = raw.map((lr) => {
      const payload     = (lr.payload ?? {}) as Record<string, unknown>;
      const lastRemarks = typeof payload.lastRemarks === 'string'
        ? payload.lastRemarks
        : null;

      return {
        id:          lr.id,
        leaveType:   lr.leaveType,
        totalDays:   Number(lr.totalDays),
        reason:      this.sanitiseText(lr.reason),
        status:      lr.status,
        lastRemarks: lastRemarks ? this.sanitiseText(lastRemarks) : null,
        submittedAt: lr.submittedAt,
      };
    });

    const corpus = this.buildCorpus(summaries, windowDays);

    // ── 5. Call Qwen ────────────────────────────────────────────────────
    const { analysis, usage } = await this.callQwen(corpus);

    // ── 6. Assemble full report ───────────────────────────────────────────
    return {
      unit_id:                  unit.id,
      unit_name:                unit.name,
      analysis_window_days:     windowDays,
      total_requests_analyzed:  summaries.length,
      generated_at:             new Date().toISOString(),
      model_used:               this.model,
      token_usage:              usage,
      analysis,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: text preparation
  // ---------------------------------------------------------------------------

  /**
   * Strips UUIDs and employee ID patterns from free-text fields to reduce the
   * risk of inadvertently sending PII-adjacent identifiers to the AI provider.
   */
  private sanitiseText(text: string): string {
    return text
      // UUID v4 pattern
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[ID]')
      // Common employee ID patterns (e.g. EMP-00123, KPN-2024-0042)
      .replace(/\b[A-Z]{2,6}-\d{3,8}\b/g, '[EMP_ID]')
      .trim();
  }

  /**
   * Converts the list of anonymised leave request summaries into a structured
   * plain-text document to attach as the user message.
   *
   * Format keeps each request compact while giving the model enough signal:
   *   [Request 1] Type: ANNUAL | Duration: 3 days | Status: APPROVED
   *   Reason: Need rest after peak project period.
   *   Remarks: Team was supportive.
   */
  private buildCorpus(
    summaries: LeaveRequestSummary[],
    windowDays: number,
  ): string {
    const header =
      `Analysis window: last ${windowDays} days\n` +
      `Total leave requests: ${summaries.length}\n\n` +
      `─── LEAVE REQUEST DATA (anonymised) ───\n\n`;

    const entries = summaries.map((s, i) => {
      const lines = [
        `[Request ${i + 1}]  Type: ${s.leaveType}  |  Duration: ${s.totalDays} day(s)  |  Status: ${s.status}`,
        `Reason: ${s.reason}`,
      ];
      if (s.lastRemarks) {
        lines.push(`Approver remarks: ${s.lastRemarks}`);
      }
      return lines.join('\n');
    });

    return header + entries.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Private: Qwen API call
  // ---------------------------------------------------------------------------

  /**
   * The system prompt is the most critical part of the integration.
   *
   * Engineering decisions:
   *   1. Role framing first — "You are an expert HR analytics AI" primes the
   *      model to weight HR-domain vocabulary higher than general text.
   *   2. Explicit analytical framework — avoids the model hallucinating its own
   *      criteria for burnout or sentiment.
   *   3. JSON schema contract at the end — placing it last keeps it in the
   *      model's recency buffer, maximising schema compliance.
   *   4. `response_format: { type: 'json_object' }` — Qwen's JSON mode
   *      prevents the model from wrapping output in markdown code fences.
   *   5. Low temperature (0.15) — reduces creative variation; we want
   *      consistent, deterministic analysis across identical datasets.
   */
  private buildSystemPrompt(): string {
    return `\
You are an expert organizational psychologist and HR analytics AI embedded in an enterprise Human Capital Information System (HCIS).

Your task is to analyse aggregated, fully anonymised leave request data from a single organisational unit and produce a structured diagnostic report for the HR Director.

═══ ANALYTICAL FRAMEWORK ═══

1. BURNOUT RISK
   Indicators: high frequency of sick/special leave, consecutive leave clusters, short-notice submissions, escalating leave durations over the window, stress or fatigue keywords in stated reasons, mentions of overwork or personal health crises.

2. WORKLOAD IMBALANCE
   Indicators: most staff requesting leave during identical periods (capacity risk), high unpaid/special leave rates relative to annual, emergency leave clustering, explicit mentions of deadlines or covering for colleagues.

3. TEAM SENTIMENT
   Classify each leave reason/remark as:
     Positive  — planned rest, family, personal growth, leisure.
     Neutral   — routine personal matters, no stress signal.
     Negative  — stress, burnout, conflict, dissatisfaction, illness linked to workload.
   Calculate integer percentages that sum to exactly 100.

4. FRICTION POINTS
   Surface recurring systemic themes mentioned across multiple requests — do NOT report one-off personal reasons.

5. RECOMMENDED ACTIONS
   Provide 3–5 specific, prioritised HR interventions (e.g. "Schedule a team load-balancing workshop within 2 weeks", not "improve morale").

═══ DATA PRIVACY ═══
You receive anonymised data. Do not attempt to identify individuals. Focus exclusively on collective patterns.

═══ STRICT OUTPUT CONTRACT ═══
• Return ONLY a single valid JSON object. No markdown code fences. No prose. No comments. No trailing commas.
• All numbers must be numeric JSON types, not strings.
• positive_pct + neutral_pct + negative_pct MUST equal exactly 100.
• confidence_score reflects how representative the data sample is (low count → low score).

Required JSON schema — every key is mandatory:
{
  "burnout_risk": {
    "level": "Low" | "Medium" | "High",
    "score": <number 0.0–10.0>,
    "reasoning": "<1–3 sentences citing specific patterns from the data>"
  },
  "workload_imbalance": {
    "detected": <boolean>,
    "severity": "None" | "Low" | "Medium" | "High",
    "signals": ["<signal>", ...]
  },
  "sentiment_overview": {
    "positive_pct": <integer 0–100>,
    "neutral_pct":  <integer 0–100>,
    "negative_pct": <integer 0–100>,
    "dominant_themes": ["<theme>", ...]
  },
  "team_friction_points": ["<friction point>", ...],
  "recommended_actions":  ["<priority 1 action>", ...],
  "confidence_score": <number 0.0–1.0>,
  "data_quality_note": "<note on data sufficiency or limitations>"
}`;
  }

  /**
   * Dispatches the corpus to the Qwen OpenAI-compatible endpoint.
   * HttpService is pre-configured with baseURL and Authorization header
   * via HttpModule.registerAsync in AiModule.
   *
   * Error taxonomy:
   *   RxJS TimeoutError      → GatewayTimeoutException (504)
   *   Axios network error    → ServiceUnavailableException (503)
   *   Non-2xx Qwen response  → ServiceUnavailableException (503) with status logged
   *   Empty / non-JSON body  → InternalServerErrorException (500)
   *   Schema validation fail → InternalServerErrorException (500) with fallback
   */
  private async callQwen(
    corpus: string,
  ): Promise<{ analysis: QwenHealthAnalysis; usage: DivisionalHealthReport['token_usage'] }> {
    const requestPayload: QwenChatRequest = {
      model:           this.model,
      temperature:     0.15,
      max_tokens:      2_048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        { role: 'user',   content: corpus },
      ],
    };

    this.logger.debug(
      `Dispatching to Qwen model="${this.model}" ` +
      `timeout=${this.timeoutMs}ms ` +
      `corpus_length=${corpus.length} chars`,
    );

    // httpService.post() returns Observable<AxiosResponse<QwenChatResponse>>.
    // We pipe through timeout() before firstValueFrom() so the timeout fires
    // on the Observable layer — not the Promise layer — giving us a typed
    // TimeoutError rather than an untyped Promise rejection.
    const response = await firstValueFrom(
      this.httpService
        .post<QwenChatResponse>('/chat/completions', requestPayload)
        .pipe(
          timeout(this.timeoutMs),
          catchError((error: unknown) => {
            if (error instanceof TimeoutError) {
              this.logger.error(
                `Qwen API timeout after ${this.timeoutMs}ms`,
              );
              throw new GatewayTimeoutException(
                `The AI service did not respond within ${this.timeoutMs / 1_000}s. ` +
                `Try again or increase QWEN_TIMEOUT_MS.`,
              );
            }

            const axiosErr = error as AxiosError;
            const status   = axiosErr.response?.status ?? 'network error';
            const body     = JSON.stringify(axiosErr.response?.data ?? axiosErr.message);

            this.logger.error(
              `Qwen API responded with ${status}: ${body.slice(0, 300)}`,
            );

            throw new ServiceUnavailableException(
              'The AI analytics service is temporarily unavailable. Please retry later.',
            );
          }),
        ),
    );

    // ── Parse content ────────────────────────────────────────────────────────
    const rawContent = response.data.choices?.[0]?.message?.content;

    if (!rawContent || rawContent.trim() === '') {
      this.logger.error('Qwen returned an empty choices[0].message.content');
      throw new InternalServerErrorException(
        'The AI service returned an empty response. Please retry.',
      );
    }

    let parsed: QwenHealthAnalysis;
    try {
      parsed = JSON.parse(rawContent) as QwenHealthAnalysis;
    } catch {
      this.logger.error(
        `Failed to parse Qwen content as JSON. ` +
        `First 300 chars: ${rawContent.slice(0, 300)}`,
      );
      throw new InternalServerErrorException(
        'The AI service returned a response that could not be parsed. Please retry.',
      );
    }

    // ── Schema validation ────────────────────────────────────────────────────
    this.assertAnalysisSchema(parsed);

    const usage = response.data.usage ?? {
      prompt_tokens:     0,
      completion_tokens: 0,
      total_tokens:      0,
    };

    this.logger.log(
      `Qwen analysis complete — ` +
      `burnout=${parsed.burnout_risk.level} ` +
      `confidence=${parsed.confidence_score} ` +
      `tokens_used=${usage.total_tokens}`,
    );

    return { analysis: parsed, usage };
  }

  /**
   * Light schema guard: catches the most common model contract violations
   * before the response reaches the client.  Does not perform deep validation
   * of every field type — full zod/class-validator integration can be added
   * if stricter contracts are needed.
   */
  private assertAnalysisSchema(data: unknown): asserts data is QwenHealthAnalysis {
    const obj = data as Record<string, unknown>;

    const requiredKeys: Array<keyof QwenHealthAnalysis> = [
      'burnout_risk',
      'workload_imbalance',
      'sentiment_overview',
      'team_friction_points',
      'recommended_actions',
      'confidence_score',
      'data_quality_note',
    ];

    for (const key of requiredKeys) {
      if (!(key in obj)) {
        this.logger.error(`Qwen schema violation: missing key "${key}"`);
        throw new InternalServerErrorException(
          `AI response is missing required field "${key}". The model may have deviated from its output contract.`,
        );
      }
    }

    const sentiment = obj.sentiment_overview as Record<string, number>;
    const pctSum = (sentiment.positive_pct ?? 0) +
                   (sentiment.neutral_pct  ?? 0) +
                   (sentiment.negative_pct ?? 0);

    if (Math.abs(pctSum - 100) > 2) {
      // Tolerate ±2 for rounding; anything larger is a model error.
      this.logger.warn(
        `Qwen sentiment percentages sum to ${pctSum} (expected 100). ` +
        `Normalising before returning.`,
      );
      // Normalise in-place so the client always receives a consistent result.
      if (pctSum > 0) {
        const factor = 100 / pctSum;
        sentiment.positive_pct = Math.round(sentiment.positive_pct * factor);
        sentiment.neutral_pct  = Math.round(sentiment.neutral_pct  * factor);
        // Assign the remainder to negative_pct to guarantee exact sum of 100.
        sentiment.negative_pct = 100 - sentiment.positive_pct - sentiment.neutral_pct;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: fallback report for units with no data
  // ---------------------------------------------------------------------------

  private buildEmptyReport(
    unitId: string,
    unitName: string,
    windowDays: number,
  ): DivisionalHealthReport {
    return {
      unit_id:                 unitId,
      unit_name:               unitName,
      analysis_window_days:    windowDays,
      total_requests_analyzed: 0,
      generated_at:            new Date().toISOString(),
      model_used:              this.model,
      token_usage:             { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      analysis: {
        burnout_risk: {
          level:     'Low',
          score:     0,
          reasoning: 'No leave request data available in the analysis window.',
        },
        workload_imbalance: {
          detected: false,
          severity: 'None',
          signals:  [],
        },
        sentiment_overview: {
          positive_pct:    0,
          neutral_pct:     100,
          negative_pct:    0,
          dominant_themes: [],
        },
        team_friction_points: [],
        recommended_actions:  [
          'Collect baseline leave data before scheduling the next analysis cycle.',
        ],
        confidence_score:  0,
        data_quality_note: `No leave requests found for this unit in the last ${windowDays} days. ` +
                           `Analysis cannot be performed without sufficient data.`,
      },
    };
  }
}
