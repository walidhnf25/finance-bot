import { Env, validateEnv } from './env.validation';

/**
 * Namespaced, typed configuration. The single source of truth is {@link validateEnv}: defaults,
 * coercion and security rules live there, so nothing here can disagree with the validator.
 * Consumers inject ConfigService and read via these keys, e.g. `config.get('telegram.polling')`.
 */
export interface Configuration {
  app: {
    nodeEnv: string;
    port: number;
    host: string;
    name: string;
    timezone: string;
    isProduction: boolean;
  };
  log: { level: string; pretty: boolean };
  database: { url: string };
  telegram: Env['telegram'];
  ai: Env['ai'];
  receipt: Env['receipt'];
  swagger: Env['swagger'];
  limits: Env['limits'];
  retention: Env['retention'];
  queue: Env['queue'];
}

export function toConfiguration(env: Env): Configuration {
  return {
    app: {
      nodeEnv: env.nodeEnv,
      port: env.port,
      host: env.host,
      name: env.appName,
      timezone: env.timezone,
      isProduction: env.nodeEnv === 'production',
    },
    log: { level: env.logLevel, pretty: env.logPretty },
    database: { url: env.databaseUrl },
    telegram: env.telegram,
    ai: env.ai,
    receipt: env.receipt,
    swagger: env.swagger,
    limits: env.limits,
    retention: env.retention,
    queue: env.queue,
  };
}

export default (): Configuration => toConfiguration(validateEnv(process.env));
