import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  fetchWithTimeout,
  HttpTimeoutError,
  readJsonBounded,
  TransientHttpError,
  withRetry,
} from 'src/common/http/http';
import { CircuitBreaker } from 'src/common/utils/circuit-breaker';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { Semaphore } from 'src/common/utils/semaphore';
import { AiHealthProbe, AiHealthStatus } from 'src/modules/health/ai-health.probe';
import { AiUnavailableError, ChatJsonRequest, ReceiptAiProvider } from '../domain/receipt-ports';

/** Kept under its old name: it is the port's {@link AiUnavailableError}. */
export { AiUnavailableError as OllamaUnavailableError };
const OllamaUnavailableError = AiUnavailableError;

interface OllamaSettings {
  provider: 'ollama' | 'none';
  ollamaBaseUrl: string;
  ollamaModel: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Optional: consecutive failures that open the breaker (default 3). */
  breakerFailures?: number;
  /** Optional: how long the breaker stays open before one probe is allowed (default 30 s). */
  breakerCooldownMs?: number;
}

interface TagsResponse {
  models?: Array<{ name?: string }>;
}
interface ShowResponse {
  capabilities?: string[];
}
interface ChatResponse {
  message?: { content?: string };
}

const SMALL_TIMEOUT_MS = 5_000;
const SMALL_MAX_BYTES = 256 * 1024;
const CAPABILITY_CACHE_MS = 60_000;

export const OLLAMA_SETTINGS = Symbol('OLLAMA_SETTINGS');

/**
 * Minimal client for an Ollama server. Nothing here is hard-coded to a model name: the model
 * is the configured one or, if none is configured, the first installed model that can complete
 * text. Capabilities (`vision`...) are read from `/api/show`, never assumed.
 */
@Injectable()
export class OllamaClient extends AiHealthProbe implements ReceiptAiProvider {
  private readonly logger = new Logger(OllamaClient.name);
  private capCache = new Map<string, { at: number; caps: string[] }>();
  /** One model request at a time: a CPU/GPU model gains nothing from parallel requests. */
  private readonly gate = new Semaphore(1);
  /**
   * Stops every receipt photo from waiting out a full AI timeout while Ollama is down: after a few
   * consecutive failures calls are refused at once (the deterministic reader takes over) and a single
   * probe re-tests the server after the cooldown.
   */
  readonly breaker: CircuitBreaker;

  constructor(
    @Inject(OLLAMA_SETTINGS) private readonly settings: OllamaSettings,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
    this.breaker = new CircuitBreaker({
      failureThreshold: settings.breakerFailures ?? 3,
      cooldownMs: settings.breakerCooldownMs ?? 30_000,
      onTransition: (from, to) => {
        this.logger.warn(`AI circuit breaker: ${from} -> ${to}`);
        this.metrics?.inc('ai_breaker_transitions_total', { to });
      },
    });
    metrics?.registerGauge('ai_breaker_open', () => (this.breaker.state === 'CLOSED' ? 0 : 1));
  }

  /**
   * Runs one logical AI operation under the breaker. A server that answered but has no model, or does
   * not support a capability, is ALIVE and does not count as a failure; unreachable/garbled replies do.
   */
  private async guarded<T>(operation: () => Promise<T>, proves: 'alive' | 'working'): Promise<T> {
    if (!this.breaker.allow()) throw new OllamaUnavailableError('unreachable');
    try {
      const result = await operation();
      this.settle(proves);
      this.metrics?.inc('ai_requests_total', { outcome: 'ok' });
      return result;
    } catch (err) {
      if (
        err instanceof OllamaUnavailableError &&
        (err.reason === 'no_model' || err.reason === 'unsupported' || err.reason === 'disabled')
      ) {
        this.settle(proves);
      } else {
        this.breaker.failure();
      }
      this.metrics?.inc('ai_requests_total', { outcome: 'unavailable' });
      throw err;
    }
  }

  /**
   * Only a CHAT answer proves the model works and resets the failure streak. Listing/inspecting models can
   * succeed while loading the model keeps failing (out of memory); letting those calls close the breaker
   * would keep it shut forever and every unsure photo would wait out the full timeout.
   */
  private settle(proves: 'alive' | 'working'): void {
    if (proves === 'working') this.breaker.success();
    else this.breaker.cancelProbe();
  }

  static fromConfig(config: ConfigService): OllamaSettings {
    return config.getOrThrow<OllamaSettings>('ai');
  }

  get enabled(): boolean {
    return this.settings.provider === 'ollama';
  }

  private async getJson<T>(path: string, body?: unknown): Promise<T> {
    try {
      return await withRetry(
        async () => {
          const res = await fetchWithTimeout(`${this.settings.ollamaBaseUrl}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            timeoutMs: SMALL_TIMEOUT_MS,
          });
          if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw res.status >= 500
              ? new TransientHttpError('Ollama returned a server error')
              : new OllamaUnavailableError('bad_response');
          }
          return readJsonBounded<T>(res, SMALL_MAX_BYTES);
        },
        { attempts: 2, baseMs: 300, maxMs: 1_000 },
      );
    } catch (err) {
      if (err instanceof OllamaUnavailableError) throw err;
      throw new OllamaUnavailableError('unreachable');
    }
  }

  async installedModels(): Promise<string[]> {
    const tags = await this.getJson<TagsResponse>('/api/tags');
    return (tags.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
  }

  async capabilities(model: string): Promise<string[]> {
    const cached = this.capCache.get(model);
    if (cached && Date.now() - cached.at < CAPABILITY_CACHE_MS) return cached.caps;
    const shown = await this.getJson<ShowResponse>('/api/show', { model });
    const caps = Array.isArray(shown.capabilities)
      ? shown.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    this.capCache.set(model, { at: Date.now(), caps });
    return caps;
  }

  /** The model to use: configured, else the first installed one that supports plain completion. */
  async resolveModel(): Promise<string> {
    if (!this.enabled) throw new OllamaUnavailableError('disabled');
    return this.guarded(() => this.resolveModelUnguarded(), 'alive');
  }

  private async resolveModelUnguarded(): Promise<string> {
    const installed = await this.installedModels();
    if (this.settings.ollamaModel) {
      if (!installed.includes(this.settings.ollamaModel))
        throw new OllamaUnavailableError('no_model');
      return this.settings.ollamaModel;
    }
    for (const name of installed) {
      if ((await this.capabilities(name)).includes('completion')) return name;
    }
    throw new OllamaUnavailableError('no_model');
  }

  /** True only when the model itself reports the `vision` capability. */
  async supportsVision(model: string): Promise<boolean> {
    return this.guarded(async () => (await this.capabilities(model)).includes('vision'), 'alive');
  }

  /**
   * Ask the model for a JSON document that follows `schema`. The reply is size-bounded and returned
   * as text for the caller to parse and validate; it is never trusted.
   */
  async chatJson(args: ChatJsonRequest): Promise<string> {
    return this.guarded(() => this.chatJsonUnguarded(args), 'working');
  }

  private async chatJsonUnguarded(args: ChatJsonRequest): Promise<string> {
    const caps = await this.capabilities(args.model);
    if (args.imagesBase64?.length && !caps.includes('vision')) {
      throw new OllamaUnavailableError('unsupported');
    }
    const body = {
      model: args.model,
      stream: false,
      format: args.schema,
      // Reasoning models would otherwise spend the whole budget "thinking".
      ...(caps.includes('thinking') ? { think: false } : {}),
      options: { temperature: 0, num_predict: 1_024 },
      messages: [
        { role: 'system', content: args.system },
        {
          role: 'user',
          content: args.user,
          ...(args.imagesBase64?.length ? { images: args.imagesBase64 } : {}),
        },
      ],
    };

    const release = await this.gate.acquire();
    try {
      const res = await fetchWithTimeout(`${this.settings.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: this.settings.timeoutMs,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new OllamaUnavailableError('bad_response');
      }
      const parsed = await readJsonBounded<ChatResponse>(res, this.settings.maxResponseBytes);
      const content = parsed.message?.content;
      if (typeof content !== 'string') throw new OllamaUnavailableError('bad_response');
      return content;
    } catch (err) {
      if (err instanceof OllamaUnavailableError) throw err;
      if (err instanceof HttpTimeoutError) this.logger.warn('Ollama request timed out');
      throw new OllamaUnavailableError('unreachable');
    } finally {
      release();
    }
  }

  /** Readiness probe: server reachable and a usable model present. Fixed strings only. */
  async check(): Promise<AiHealthStatus> {
    if (!this.enabled) return { available: false, detail: 'AI disabled (AI_PROVIDER=none)' };
    if (this.breaker.blocked()) {
      return {
        available: false,
        detail: 'Ollama is paused after repeated failures; retrying shortly',
      };
    }
    try {
      await this.resolveModel();
      return { available: true };
    } catch (err) {
      const reason = err instanceof OllamaUnavailableError ? err.reason : 'unreachable';
      return {
        available: false,
        detail:
          reason === 'no_model'
            ? 'Ollama is running but no usable model is installed'
            : 'Ollama is not reachable',
      };
    }
  }
}
