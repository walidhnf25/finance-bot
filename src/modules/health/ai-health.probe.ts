/** What the readiness check needs to know about the AI runtime. */
export interface AiHealthStatus {
  available: boolean;
  detail?: string;
}

/**
 * Implemented by the AI module (Ollama). Kept as an abstract class so the health module does not
 * depend on any particular provider, and so tests can substitute it.
 */
export abstract class AiHealthProbe {
  abstract check(): Promise<AiHealthStatus>;
}
