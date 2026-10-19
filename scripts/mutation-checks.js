#!/usr/bin/env node
/**
 * Targeted mutation checks for the guards that protect money, identity and data.
 *
 * For each guard it removes or weakens ONE protection in a private COPY of the working tree and runs
 * the tests that are supposed to fail. A mutant that does not make them fail "survives": the guard
 * could be deleted without the test suite noticing.
 *
 *   node scripts/mutation-checks.js              all mutants
 *   node scripts/mutation-checks.js M01,M10      some of them
 *   KEEP_COPY=1 node scripts/mutation-checks.js  leave the copy for inspection
 *
 * Safety: the repository itself is never modified. The copy lives in the OS temp directory,
 * node_modules is shared through a junction/symlink that is removed BEFORE the copy is deleted, and
 * `.env` is copied only so the integration tests find the (guarded, `finance_bot_test`-only) database.
 * Run it with nothing else using the test database. It samples guards; it is NOT an exhaustive
 * mutation tester (no Stryker-style generation of every possible mutant).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const TIMEOUT_MS = 600_000;

const UNIT = (...f) => ({ cmd: `npx jest ${f.join(' ')}` });
const INT = (...f) => ({
  cmd: `npx jest --config ./test/jest-integration.json --runInBand ${f.map((x) => 'test/integration/' + x).join(' ')}`,
});
const E2E = (...f) => ({
  cmd: `npx jest --config ./test/jest-e2e.json --runInBand ${f.map((x) => 'test/e2e/' + x).join(' ')}`,
});

const QUEUE = (...f) => ({
  cmd: `docker compose --profile queue up -d --wait redis && npx jest --config ./test/jest-queue.json --runInBand --forceExit ${f
    .map((x) => 'test/queue/' + x)
    .join(' ')}`,
});

const FAILURE = (...f) => ({
  cmd: `npx jest --config ./test/jest-failure.json --runInBand --forceExit ${f
    .map((x) => 'test/failure/' + x)
    .join(' ')}`,
});

const WEBHOOK = 'src/modules/bot/infrastructure/telegram-webhook.controller.ts';
const GATEWAY = 'src/modules/bot/infrastructure/telegram.gateway.ts';
const POLLER = 'src/modules/bot/infrastructure/telegram.poller.ts';
const TXREPO = 'src/modules/transaction/infrastructure/prisma-transaction.repository.ts';
const RECEIPT_REPO = 'src/modules/receipt/infrastructure/prisma-receipt.repository.ts';
const RECEIPT_DOMAIN = 'src/modules/receipt/domain/receipt-extraction.ts';
const RECEIPT_SVC = 'src/modules/receipt/application/receipt.service.ts';
const EXTRACTOR = 'src/modules/receipt/application/receipt-extractor.ts';
const IMAGE = 'src/modules/receipt/infrastructure/image-processor.ts';
const MONEY = 'src/shared/utils/money.ts';
const ORCH = 'src/modules/bot/application/message-orchestrator.ts';
const LIMITER = 'src/common/utils/rate-limiter.ts';
const ENV = 'src/config/env.validation.ts';
const HANDLER = 'src/modules/bot/application/incoming-message.handler.ts';
const BREAKER = 'src/common/utils/circuit-breaker.ts';
const OCR = 'src/modules/receipt/infrastructure/ocr.ts';
const READER = 'src/modules/receipt/application/receipt-reader.ts';
const HEURISTIC = 'src/modules/receipt/domain/heuristic-extractor.ts';
const METRICS = 'src/modules/observability/metrics.service.ts';
const METRICS_CTRL = 'src/modules/observability/metrics.controller.ts';
const CATEGORY_REPO = 'src/modules/category/infrastructure/prisma-category.repository.ts';
const RETENTION = 'src/modules/retention/infrastructure/retention.service.ts';
const AUDIT_DB = 'src/modules/audit/infrastructure/db-audit-log.repository.ts';
const RESET = 'src/modules/user/application/reset-user-data.service.ts';
const BUDGET_REPO = 'src/modules/budget/infrastructure/prisma-budget.repository.ts';
const OLLAMA = 'src/modules/receipt/infrastructure/ollama.client.ts';
const BUDGET_SVC = 'src/modules/budget/application/budget.service.ts';
const BULL = 'src/modules/queue/infrastructure/bull-job-queue.ts';
const JOB_PAYLOAD = 'src/modules/bot/application/receipt-job.payload.ts';
const JOB_HANDLER = 'src/modules/bot/application/receipt-job.handler.ts';
const JOB_PRODUCER = 'src/modules/bot/application/receipt-job.producer.ts';
const HEALTH = 'src/modules/health/health.service.ts';
const LIBDB = 'scripts/lib-db.sh';
const PROCESSOR = 'src/modules/bot/infrastructure/update-processor.ts';
const YESNO = 'src/modules/bot/application/yes-no.ts';
const PARSER = 'src/modules/parser/rule-based/rule-based.parser.ts';
const TOKENIZER = 'src/modules/parser/rule-based/amount.tokenizer.ts';
const TIMEOUT = 'src/common/interceptors/timeout.interceptor.ts';

/** { id, what, file, edits: [[exact text, replacement]], detect: [{cmd}] } */
const MUTANTS = [
  // ---- who may talk to the bot -------------------------------------------------------------
  {
    id: 'M01',
    what: 'webhook secret no longer checked',
    file: WEBHOOK,
    edits: [
      [
        'if (!this.secret || !this.matchesSecret(secretHeader)) {',
        'if ((!this.secret || !this.matchesSecret(secretHeader)) && Date.now() < 0) {',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/infrastructure/telegram-webhook.controller.spec.ts'),
      E2E('bot.e2e-spec.ts'),
    ],
  },
  {
    id: 'M02',
    what: 'webhook secret compared by length only',
    file: WEBHOOK,
    edits: [
      [
        'return actual.length === expected.length && timingSafeEqual(actual, expected);',
        'return actual.length === expected.length && (timingSafeEqual(actual, expected) || Date.now() > 0);',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/infrastructure/telegram-webhook.controller.spec.ts'),
      E2E('bot.e2e-spec.ts'),
    ],
  },
  {
    id: 'M03',
    what: 'allowlist ignored',
    file: GATEWAY,
    edits: [
      [
        'if (this.allowedUserIds.size > 0) return this.allowedUserIds.has(userId);',
        'if (this.allowedUserIds.size > 0) return this.allowedUserIds.has(userId) || Date.now() > 0;',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/infrastructure/telegram.gateway.spec.ts'),
      E2E('bot.e2e-spec.ts'),
    ],
  },
  {
    id: 'M04',
    what: 'empty allowlist means everyone',
    file: GATEWAY,
    edits: [
      ['    return this.allowPublic;\n  }', '    return this.allowPublic || Date.now() > 0;\n  }'],
    ],
    detect: [UNIT('src/modules/bot/infrastructure/telegram.gateway.spec.ts')],
  },
  {
    id: 'M05',
    what: 'server may bind to every network interface without opting in',
    file: ENV,
    edits: [['if (!isLoopbackHost(host) && !allowRemoteBind) {', 'if (Date.now() < 0) {']],
    detect: [UNIT('src/config/env.validation.spec.ts')],
  },
  // ---- ownership: a row id alone never grants access ---------------------------------------
  {
    id: 'M06',
    what: 'softDelete loses its owner filter',
    file: TXREPO,
    edits: [
      [
        'where: { id, userId, deletedAt: null },\n      data: { deletedAt: new Date() },',
        'where: { id, deletedAt: null, ...(Date.now() < 0 ? { userId } : {}) },\n      data: { deletedAt: new Date() },',
      ],
    ],
    detect: [INT('transaction.repository.spec.ts', 'repositories.spec.ts')],
  },
  {
    id: 'M07',
    what: 'update loses its owner filter (both the write and the re-read)',
    file: TXREPO,
    edits: [
      [
        'where: { id, userId, deletedAt: null },\n        data: {',
        'where: { id, deletedAt: null, ...(Date.now() < 0 ? { userId } : {}) },\n        data: {',
      ],
      [
        'findFirstOrThrow({ where: { id, userId } })',
        'findFirstOrThrow({ where: { id, ...(Date.now() < 0 ? { userId } : {}) } })',
      ],
    ],
    detect: [INT('transaction.repository.spec.ts', 'repositories.spec.ts')],
  },
  {
    id: 'M08',
    what: 'findById loses its owner filter',
    file: TXREPO,
    edits: [
      [
        'findFirst({ where: { id, userId, deletedAt: null } })',
        'findFirst({ where: { id, deletedAt: null, ...(Date.now() < 0 ? { userId } : {}) } })',
      ],
    ],
    detect: [INT('transaction.repository.spec.ts', 'repositories.spec.ts')],
  },
  // ---- idempotency: a retried message never writes twice -----------------------------------
  {
    id: 'M09',
    what: 'unique-key violation no longer means "already recorded"',
    file: TXREPO,
    edits: [
      [
        "if (isUniqueViolation(err, ['user_id', 'idempotency_key'])) return null;",
        'if (Date.now() < 0) return null;',
      ],
    ],
    detect: [INT('transaction.repository.spec.ts')],
  },
  {
    id: 'M10',
    what: 'batch no longer skips items already stored',
    file: TXREPO,
    edits: [
      [
        'if (existing) {\n              results.push(null);\n              continue;\n            }',
        'if (existing && Date.now() < 0) {\n              results.push(null);\n              continue;\n            }',
      ],
    ],
    detect: [INT('transaction.repository.spec.ts')],
  },
  // ---- receipt confirmation ------------------------------------------------------------------
  {
    id: 'M11',
    what: 'receipt confirmation takes no row lock',
    file: RECEIPT_REPO,
    edits: [['AND user_id = ${userId} FOR UPDATE`;', 'AND user_id = ${userId}`;']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M12',
    what: 'receipt lookup ignores the owner',
    file: RECEIPT_REPO,
    edits: [
      [
        'WHERE id = ${draftId} AND user_id = ${userId} FOR UPDATE`;',
        'WHERE id = ${draftId} FOR UPDATE`;',
      ],
    ],
    detect: [INT('receipt.spec.ts'), E2E('receipt.e2e-spec.ts')],
  },
  {
    id: 'M13',
    what: 'expired draft can still be confirmed',
    file: RECEIPT_REPO,
    edits: [
      [
        "if (draft.status === 'EXPIRED' || draft.expiresAt <= now) {",
        "if (draft.status === 'EXPIRED' || (draft.expiresAt <= now && Date.now() < 0)) {",
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M14',
    what: 'already confirmed draft is confirmed again',
    file: RECEIPT_REPO,
    edits: [["if (draft.status === 'CONFIRMED') return { kind: 'already_confirmed' };", '']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M15',
    what: 'cancelled draft can be confirmed',
    file: RECEIPT_REPO,
    edits: [["if (draft.status === 'CANCELLED') return { kind: 'cancelled' };", '']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M16',
    what: 'confirmed transaction no longer carries the draft idempotency key',
    file: RECEIPT_REPO,
    edits: [['idempotencyKey: `receipt:${draftId}`,', 'idempotencyKey: null,']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M17',
    what: 'same photo creates a new draft even while one is pending',
    file: RECEIPT_REPO,
    edits: [
      [
        "if (existing.status === 'PENDING' && existing.expiresAt > input.now) {",
        'if (Date.now() < 0) {',
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  // ---- receipt content is untrusted -----------------------------------------------------------
  {
    id: 'M18',
    what: 'a non-positive total is accepted (no positivity check at all)',
    file: RECEIPT_DOMAIN,
    edits: [
      ['if (total === null || total <= 0)', 'if (total === null)'],
      [
        'if (!Money.fromMajor(total).isWithinLimit())',
        'if (!Money.fromMajor(total).isWithinLimit() && Date.now() < 0)',
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  {
    id: 'M19',
    what: 'an absurdly large total is accepted',
    file: RECEIPT_DOMAIN,
    edits: [
      [
        'if (!Money.fromMajor(total).isWithinLimit())',
        'if (!Money.fromMajor(total).isWithinLimit() && Date.now() < 0)',
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  {
    id: 'M20',
    what: 'a total that is not in the photo text is no longer flagged',
    file: RECEIPT_DOMAIN,
    edits: [
      ['if (ctx.sourceText && !numbersInText(ctx.sourceText).has(total))', 'if (Date.now() < 0)'],
    ],
    detect: [
      UNIT(
        'src/modules/receipt/domain/receipt-extraction.spec.ts',
        'src/modules/receipt/application/receipt-extractor.spec.ts',
      ),
    ],
  },
  {
    id: 'M21',
    what: 'control and bidi characters are not stripped from receipt text',
    file: RECEIPT_DOMAIN,
    edits: [
      [
        "return value.replace(CONTROL_CHARS, ' ')",
        "return value.replace(Date.now() < 0 ? CONTROL_CHARS : /(?!)/g, ' ')",
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  {
    id: 'M22',
    what: 'a receipt dated in the future is kept',
    file: RECEIPT_DOMAIN,
    edits: [['if (candidate > tomorrow) {', 'if (candidate > tomorrow && Date.now() < 0) {']],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  {
    id: 'M23',
    what: 'the wallet named by the model is trusted',
    file: EXTRACTOR,
    edits: [
      ['const { wallet: _ignored, ...fromModel } =', 'const { ...fromModel } ='],
      ['void _ignored;', ''],
    ],
    detect: [UNIT('src/modules/receipt/application/receipt-extractor.spec.ts')],
  },
  {
    id: 'M24',
    what: 'receipt text is not fenced as untrusted data',
    file: EXTRACTOR,
    edits: [['return `<receipt>\\n${safe}\\n</receipt>`;', 'return safe;']],
    detect: [
      UNIT(
        'src/modules/receipt/application/receipt-ai-safety.spec.ts',
        'src/modules/receipt/application/receipt-extractor.spec.ts',
      ),
      E2E('receipt.e2e-spec.ts'),
    ],
  },
  {
    id: 'M25',
    what: 'uploaded files are not checked by their magic bytes',
    file: IMAGE,
    edits: [["if (!sniffFormat(bytes)) throw new InvalidImageError('unsupported');", '']],
    detect: [UNIT('src/modules/receipt/infrastructure/image-processor.spec.ts')],
  },
  {
    id: 'M26',
    what: 'image size limit removed',
    file: IMAGE,
    edits: [["if (bytes.length > limits.maxBytes) throw new InvalidImageError('too_large');", '']],
    detect: [UNIT('src/modules/receipt/infrastructure/image-processor.spec.ts')],
  },
  {
    id: 'M27',
    what: 'pixel limit (decompression bomb guard) removed in both places',
    file: IMAGE,
    edits: [
      ['limitInputPixels: limits.maxPixels,', 'limitInputPixels: false,'],
      [
        "if (meta.width * meta.height > limits.maxPixels) throw new InvalidImageError('too_many_pixels');",
        '',
      ],
    ],
    detect: [UNIT('src/modules/receipt/infrastructure/image-processor.spec.ts')],
  },
  {
    id: 'M28',
    what: 'per-hour receipt limit removed',
    file: RECEIPT_SVC,
    edits: [['      this.limits.maxPerHour\n', '      this.limits.maxPerHour * 1000\n']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M29',
    what: 'a one-wallet user can be put into the other wallet by a receipt',
    file: RECEIPT_SVC,
    edits: [['if (user.walletMode === WalletMode.CASH) return Wallet.CASH;', '']],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M30',
    what: 'a photo records a transaction without confirmation (draft step skipped)',
    file: ORCH,
    edits: [
      [
        'const result = await this.receipts.submit(user, bytes, message.timestamp);',
        'const result = await this.receipts.submit(user, bytes, message.timestamp);\n    if (result.kind === "draft") await this.receipts.confirm(user, message.timestamp);',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/application/message-orchestrator.spec.ts'),
      E2E('receipt.e2e-spec.ts'),
    ],
  },
  // ---- money -----------------------------------------------------------------------------------
  {
    id: 'M31',
    what: 'maximum amount no longer enforced',
    file: MONEY,
    edits: [
      ['return this.minor > 0n && this.minor <= MAX_AMOUNT_MINOR;', 'return this.minor > 0n;'],
    ],
    detect: [
      UNIT(
        'src/shared/utils/money.spec.ts',
        'src/modules/bot/application/message-orchestrator.spec.ts',
      ),
    ],
  },
  {
    id: 'M32',
    what: 'oversized amounts are accepted by the bot',
    file: ORCH,
    edits: [
      [
        '!amount.isWithinLimit() && !amount.isZero()',
        '(!amount.isWithinLimit() && !amount.isZero()) && Date.now() < 0',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/application/message-orchestrator.spec.ts'),
      E2E('bot.e2e-spec.ts'),
    ],
  },
  // ---- abuse and delivery guarantees ----------------------------------------------------------
  {
    id: 'M33',
    what: 'per-user rate limit effectively off',
    file: LIMITER,
    edits: [['if (recent.length >= this.limit) {', 'if (recent.length >= this.limit * 100000) {']],
    detect: [UNIT('src/common/utils/rate-limiter.spec.ts'), E2E('bot.e2e-spec.ts')],
  },
  {
    id: 'M34',
    what: 'a failed update is skipped (offset advances without success)',
    file: POLLER,
    edits: [
      [
        "while ((await this.processor.process(update)) === 'retry' && !this.stopped) {",
        "while (Date.now() < 0 && (await this.processor.process(update)) === 'retry' && !this.stopped) {",
      ],
    ],
    detect: [UNIT('src/modules/bot/infrastructure/telegram.poller.spec.ts')],
  },
  {
    id: 'M35',
    what: 'message marked handled before it succeeded',
    file: HANDLER,
    edits: [
      [
        '    const decision = this.rateLimiter.tryAcquire(message.from);',
        '    this.dedupe.markDone(message.messageId);\n    const decision = this.rateLimiter.tryAcquire(message.from);',
      ],
    ],
    detect: [
      UNIT('src/modules/bot/application/incoming-message.handler.spec.ts'),
      E2E('bot.e2e-spec.ts'),
    ],
  },
  {
    id: 'M36',
    what: 'retry limit removed: a poison update would loop forever',
    file: PROCESSOR,
    edits: [['if (attempts < MAX_UPDATE_ATTEMPTS) {', 'if (Date.now() > 0) {']],
    detect: [UNIT('src/modules/bot/infrastructure/update-processor.spec.ts')],
  },
  {
    id: 'M37',
    what: 'Total Item/Pajak/Service lines are read as the total',
    file: 'src/modules/receipt/domain/heuristic-extractor.ts',
    edits: [
      [
        'if (NOT_THE_TOTAL.test(line)) return null;',
        'if (NOT_THE_TOTAL.test(line) && Date.now() < 0) return null;',
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/heuristic-regression.spec.ts')],
  },
  {
    id: 'M38',
    what: 'a payment line (Bayar/Tunai) can be taken as the total',
    file: 'src/modules/receipt/domain/heuristic-extractor.ts',
    edits: [
      [
        "return TENDER_LABEL.test(line.replace(PLAIN_LABEL, '')) ? null : 'plain';",
        "return TENDER_LABEL.test(line.replace(PLAIN_LABEL, '')) && Date.now() < 0 ? null : 'plain';",
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/heuristic-regression.spec.ts')],
  },
  {
    id: 'M39',
    what: 'paid-minus-change conflict is no longer reported',
    file: 'src/modules/receipt/domain/heuristic-extractor.ts',
    edits: [
      [
        '} else if (total !== null && implied !== null && implied !== total) {',
        '} else if (total !== null && implied !== null && implied !== total && Date.now() < 0) {',
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/heuristic-regression.spec.ts')],
  },
  {
    id: 'M40',
    what: 'the model total outranks the printed total line',
    file: EXTRACTOR,
    edits: [
      [
        'return { ...extraction, total: h.total, warnings: [...warnings] };',
        'return { ...extraction, total: Date.now() > 0 ? extraction.total : h.total, warnings: [...warnings] };',
      ],
    ],
    detect: [UNIT('src/modules/receipt/application/receipt-extractor.spec.ts')],
  },
  {
    id: 'M41',
    what: "'auto' mode always asks the (slow) model",
    file: EXTRACTOR,
    edits: [
      [
        "const skipModel = this.aiMode === 'never' || (this.aiMode === 'auto' && confident);",
        "const skipModel = this.aiMode === 'never' || (this.aiMode === 'auto' && confident && Date.now() < 0);",
      ],
    ],
    detect: [
      UNIT('src/modules/receipt/application/receipt-extractor.spec.ts'),
      E2E('hardening.e2e-spec.ts'),
    ],
  },
  {
    id: 'M42',
    what: 'a receipt stamps CASH on a user who never set up wallets (flips them into wallet questions)',
    file: RECEIPT_SVC,
    edits: [
      [
        'return user.walletMode === WalletMode.BOTH ? Wallet.CASH : null;',
        'return Date.now() > 0 ? Wallet.CASH : null;',
      ],
    ],
    detect: [INT('receipt.spec.ts'), E2E('receipt.e2e-spec.ts')],
  },
  {
    id: 'M43',
    what: 'a genuinely old receipt date is kept without any warning',
    file: RECEIPT_DOMAIN,
    edits: [
      [
        "if (candidate < oldest) warnings.push('DATE_OLD');",
        "if (candidate < oldest && Date.now() < 0) warnings.push('DATE_OLD');",
      ],
    ],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  // ---- resilience: the AI and OCR must not be able to stall or flood the bot ----------------------------
  {
    id: 'M44',
    what: 'the AI circuit breaker never opens',
    file: BREAKER,
    edits: [
      [
        "if (this.current === 'CLOSED' && this.consecutiveFailures >= this.options.failureThreshold) {",
        "if (Date.now() < 0 && this.current === 'CLOSED' && this.consecutiveFailures >= this.options.failureThreshold) {",
      ],
    ],
    detect: [UNIT('src/common/utils/circuit-breaker.spec.ts')],
  },
  {
    id: 'M45',
    what: 'a half-open breaker admits every caller, not a single probe',
    file: BREAKER,
    edits: [['    if (this.probeInFlight) return false;\n', '']],
    detect: [UNIT('src/common/utils/circuit-breaker.spec.ts')],
  },
  {
    id: 'M46',
    what: 'the breaker is not consulted before calling Ollama',
    file: OLLAMA,
    edits: [
      [
        "if (!this.breaker.allow()) throw new OllamaUnavailableError('unreachable');",
        "if (Date.now() < 0) throw new OllamaUnavailableError('unreachable');",
      ],
    ],
    detect: [UNIT('src/modules/receipt/infrastructure/ollama.client.spec.ts')],
  },
  {
    id: 'M47',
    what: 'the OCR queue has no depth limit',
    file: OCR,
    edits: [
      [
        'if (this.pending >= this.maxPending) {',
        'if (Date.now() < 0 && this.pending >= this.maxPending) {',
      ],
    ],
    detect: [UNIT('src/modules/receipt/infrastructure/ocr.spec.ts')],
  },
  {
    id: 'M48',
    what: 'a busy OCR is reported as "nothing readable"',
    file: READER,
    edits: [["if (err.reason === 'busy') throw err;", 'if (Date.now() < 0) throw err;']],
    detect: [
      UNIT('src/modules/receipt/application/receipt-extractor.spec.ts'),
      INT('receipt.spec.ts'),
    ],
  },
  // ---- untrusted receipt content ------------------------------------------------------------------------
  {
    id: 'M49',
    what: 'tag-like text inside a receipt can close the data block early',
    file: EXTRACTOR,
    edits: [
      [
        "const safe = text.replace(/<\\s*\\/?\\s*receipt\\b[^>]*>/gi, '[tag removed]');",
        'const safe = text;',
      ],
    ],
    detect: [UNIT('src/modules/receipt/application/receipt-ai-safety.spec.ts')],
  },
  {
    id: 'M50',
    what: 'two different printed totals are no longer flagged',
    file: HEURISTIC,
    edits: [
      [
        "if (stated.size > 1) warnings.push('TOTAL_AMBIGUOUS');",
        "if (stated.size > 1000) warnings.push('TOTAL_AMBIGUOUS');",
      ],
    ],
    detect: [
      UNIT(
        'src/modules/receipt/domain/heuristic-regression.spec.ts',
        'src/modules/receipt/application/receipt-ai-safety.spec.ts',
      ),
    ],
  },
  // ---- bounded work and observability --------------------------------------------------------------------
  {
    id: 'M51',
    what: 'the message length cap is off',
    file: HANDLER,
    edits: [
      [
        'if (message.text.length > this.maxInputChars) {',
        'if (message.text.length > this.maxInputChars * 1000) {',
      ],
    ],
    detect: [E2E('observability.e2e-spec.ts')],
  },
  {
    id: 'M52',
    what: '/metrics answers a foreign Host header (DNS rebinding)',
    file: METRICS_CTRL,
    edits: [
      [
        'if (!isMetricsHostAllowed(host)) throw new ForbiddenException();',
        'if (Date.now() < 0 && !isMetricsHostAllowed(host)) throw new ForbiddenException();',
      ],
    ],
    detect: [E2E('observability.e2e-spec.ts')],
  },
  {
    id: 'M53',
    what: 'any text can become a metric label (ids, text, cardinality)',
    file: METRICS,
    edits: [
      [
        "const value = raw !== undefined && allowed.includes(raw) ? raw : 'other';",
        "const value = raw ?? (allowed.length >= 0 ? 'other' : 'other');",
      ],
    ],
    detect: [UNIT('src/modules/observability/metrics.service.spec.ts')],
  },
  // ---- ownership, again, at the points added today ----------------------------------------------------------
  {
    id: 'M54',
    what: 'a category lookup by id ignores the owner',
    file: CATEGORY_REPO,
    edits: [
      [
        'where: { id, OR: [{ userId }, { isSystem: true }] },',
        'where: { id, ...(userId ? {} : {}) },',
      ],
    ],
    detect: [INT('isolation-probes.spec.ts')],
  },
  {
    id: 'M55',
    what: 'cancelling a receipt draft ignores the owner',
    file: RECEIPT_REPO,
    edits: [
      [
        "where: { id: draftId, userId, status: 'PENDING' },\n      data: { status: 'CANCELLED' },",
        "where: { id: draftId, status: 'PENDING', ...(userId ? {} : {}) },\n      data: { status: 'CANCELLED' },",
      ],
    ],
    detect: [INT('isolation-probes.spec.ts')],
  },
  {
    id: 'M56',
    what: 'a new repository method that forgets the owner filter (caught by the static check AND the probes)',
    file: BUDGET_REPO,
    edits: [
      [
        'const rows = await this.prisma.budget.findMany({ where: { userId } });',
        'const rows = await this.prisma.budget.findMany({ where: {} });',
      ],
    ],
    detect: [UNIT('src/user-scoping.spec.ts'), INT('isolation-probes.spec.ts')],
  },
  {
    id: 'M57',
    what: 'the application layer imports the database directly (layering erodes)',
    file: BUDGET_SVC,
    edits: [
      [
        "import { Injectable, Optional } from '@nestjs/common';",
        "import { Injectable, Optional } from '@nestjs/common';\nimport { PrismaService } from 'src/database/prisma.service';\nexport type LeakedDb = PrismaService;",
      ],
    ],
    detect: [UNIT('src/architecture.spec.ts')],
  },
  // ---- retention and audit ------------------------------------------------------------------------------------
  {
    id: 'M58',
    what: 'retention also deletes CONFIRMED receipt drafts',
    file: RETENTION,
    edits: [
      [
        "status: { in: ['CANCELLED', 'EXPIRED'] }",
        "status: { in: ['CANCELLED', 'EXPIRED', 'CONFIRMED'] }",
      ],
    ],
    detect: [INT('audit-and-retention.spec.ts')],
  },
  {
    id: 'M59',
    what: 'per-message chatter is stored in the audit table',
    file: AUDIT_DB,
    edits: [['if (!STORED_AUDIT_ACTIONS.has(input.action)) return;', '']],
    detect: [INT('audit-and-retention.spec.ts')],
  },
  {
    id: 'M60',
    what: 'a reset is no longer recorded in the audit trail',
    file: RESET,
    edits: [["await this.audit?.record({ userId, action: 'USER_RESET' });", 'void this.audit;']],
    detect: [INT('audit-and-retention.spec.ts')],
  },
  {
    id: 'M61',
    what: 'a negation no longer wins ("jangan ya" must not confirm, "gak jadi" must cancel)',
    file: YESNO,
    edits: [["if (tokens.some((t) => NO_WORDS.has(t))) return 'no';", 'void NO_WORDS;']],
    detect: [UNIT('src/modules/bot/application/yes-no.spec.ts')],
  },
  {
    id: 'M62',
    what: 'an edit word anywhere in a message hijacks it ("ganti oli 150rb")',
    file: PARSER,
    edits: [
      [
        'const index = ordered.slice(0, 2).findIndex((t) => EDIT_WORDS.includes(t));',
        'const index = ordered.findIndex((t) => EDIT_WORDS.includes(t));',
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/rule-based.parser.spec.ts')],
  },
  {
    id: 'M63',
    what: 'a delete word anywhere in a message deletes the last transaction',
    file: PARSER,
    edits: [
      [
        'ordered.slice(0, 2).some((t) => words.includes(t))',
        'ordered.some((t) => words.includes(t))',
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/rule-based.parser.spec.ts')],
  },
  {
    id: 'M64',
    what: 'a quantity ("25kg", "2 gelas") is taken as the price',
    file: TOKENIZER,
    edits: [
      [
        'QUANTITY_WORDS.has(after[1].toLowerCase()) &&',
        'Date.now() < 0 && QUANTITY_WORDS.has(after[1].toLowerCase()) &&',
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/amount.tokenizer.spec.ts')],
  },
  {
    id: 'M65',
    what: 'the first bare number wins even when a real price follows',
    file: TOKENIZER,
    edits: [
      [
        'return candidates.find((c) => c.amount.toNumber() >= PRICE_FLOOR) ?? candidates[0] ?? null;',
        'return candidates[0] ?? null;',
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/amount.tokenizer.spec.ts')],
  },
  {
    id: 'M66',
    what: 'a model LISTING success resets the breaker, so failing chats never open it',
    file: OLLAMA,
    edits: [
      [
        "if (proves === 'working') this.breaker.success();",
        "if (proves === 'working' || proves === 'alive') this.breaker.success();",
      ],
    ],
    detect: [UNIT('src/modules/receipt/infrastructure/ollama.client.spec.ts')],
  },
  {
    id: 'M67',
    what: '/metrics trusts the Host header alone (no TCP peer check)',
    file: METRICS_CTRL,
    edits: [
      [
        'if (!isLoopbackPeer(req.socket?.remoteAddress)) throw new ForbiddenException();',
        'if (Date.now() < 0 && !isLoopbackPeer(req.socket?.remoteAddress)) throw new ForbiddenException();',
      ],
    ],
    detect: [UNIT('src/modules/observability/metrics.controller.spec.ts')],
  },
  {
    id: 'M68',
    what: 'a receipt correction returns the OLD expiry (the conversation lapses early)',
    file: RECEIPT_SVC,
    edits: [
      [
        '{ draft: { ...draft, extraction: next, expiresAt }, extraction: next }',
        '{ draft: { ...draft, extraction: next }, extraction: next }',
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M69',
    what: 'the Telegram webhook is cut at 15 s (Telegram redelivers mid-processing)',
    file: TIMEOUT,
    edits: [
      [
        "if (url.startsWith('/telegram/webhook')) {",
        "if (Date.now() < 0 && url.startsWith('/telegram/webhook')) {",
      ],
    ],
    detect: [UNIT('src/common/interceptors/timeout.interceptor.spec.ts')],
  },
  {
    id: 'M70',
    what: '"10,000" is read as a decimal (Rp10)',
    file: TOKENIZER,
    edits: [
      [
        "COMMA_THOUSANDS_RE.test(numStr) ? numStr.replace(/,/g, '') : numStr,",
        "COMMA_THOUSANDS_RE.test(numStr) && Date.now() < 0 ? numStr.replace(/,/g, '') : numStr,",
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/amount.tokenizer.spec.ts')],
  },
  {
    id: 'M71',
    what: 'a receipt amount "15.000,50" is read as 1.500.050 (cents kept as digits)',
    file: RECEIPT_DOMAIN,
    edits: [['(cents ? cents[1] : cleaned)', '(cents && Date.now() < 0 ? cents[1] : cleaned)']],
    detect: [UNIT('src/modules/receipt/domain/receipt-extraction.spec.ts')],
  },
  {
    id: 'M72',
    what: 'Redis down makes the receipt fail instead of falling back to in-process reading',
    file: JOB_PRODUCER,
    edits: [
      [
        'if (!(err instanceof QueueUnavailableError)) throw err;',
        'if (Date.now() > 0 || !(err instanceof QueueUnavailableError)) throw err;',
      ],
    ],
    detect: [UNIT('src/modules/bot/application/receipt-job.spec.ts')],
  },
  {
    id: 'M73',
    what: "a queued job may write to a chat that is not the user's own",
    file: JOB_HANDLER,
    edits: [
      [
        "if (user.chatId !== job.chatId) throw new RejectedJobError('chat_mismatch');",
        'void job.chatId;',
      ],
    ],
    detect: [UNIT('src/modules/bot/application/receipt-job.spec.ts')],
  },
  {
    id: 'M74',
    what: 'a job payload with extra fields is accepted (Redis content trusted)',
    file: JOB_PAYLOAD,
    edits: [
      [
        "if (!ALLOWED_KEYS.has(key)) throw new RejectedJobError('unexpected_field');",
        "if (!ALLOWED_KEYS.has(key) && Date.now() < 0) throw new RejectedJobError('unexpected_field');",
      ],
    ],
    detect: [UNIT('src/modules/bot/application/receipt-job.payload.spec.ts')],
  },
  {
    id: 'M75',
    what: 'the same job id is no longer reported as a duplicate',
    file: BULL,
    edits: [
      [
        'if (options.jobId && (await withTimeout(q.getJob(options.jobId), PRODUCER_TIMEOUT_MS))) {',
        'if (Date.now() < 0 && options.jobId && (await withTimeout(q.getJob(options.jobId), PRODUCER_TIMEOUT_MS))) {',
      ],
    ],
    detect: [QUEUE('bull-job-queue.queue-spec.ts')],
  },
  {
    id: 'M76',
    what: 'a rejected (hostile) job is retried like a transient failure',
    file: BULL,
    edits: [
      [
        'throw new UnrecoverableError(err.message);',
        'throw Date.now() > 0 ? err : new UnrecoverableError(err.message);',
      ],
    ],
    detect: [QUEUE('bull-job-queue.queue-spec.ts')],
  },
  {
    id: 'M77',
    what: 'the user is not told when a receipt job gave up',
    file: BULL,
    edits: [['if (notify) await notify(job.data, reasonOf(err));', 'void notify;']],
    detect: [QUEUE('bull-job-queue.queue-spec.ts')],
  },
  {
    id: 'M78',
    what: 'a connection to a dead Redis keeps retrying after shutdown (the process can never exit)',
    file: BULL,
    edits: [
      ['(this.closing ? null : Math.min(times * 200, 3_000))', 'Math.min(times * 200, 3_000)'],
    ],
    detect: [QUEUE('bull-job-queue.queue-spec.ts')],
  },
  {
    id: 'M79',
    what: 'an unreachable Redis is reported as the queue being DOWN instead of degraded (the app would read as healthy)',
    file: HEALTH,
    edits: [
      [
        "? { status: 'up' }\n          : { status: 'degraded', detail: 'Redis is not reachable; receipts are read in-process' };",
        "? { status: 'up' }\n          : { status: 'down', detail: 'Redis is not reachable; receipts are read in-process' };",
      ],
    ],
    detect: [UNIT('src/modules/health/health.service.spec.ts')],
  },
  {
    id: 'M80',
    what: 'a non-loopback Redis without a password is accepted',
    file: ENV,
    edits: [['!isLoopbackHost(u.hostname) &&', 'false && !isLoopbackHost(u.hostname) &&']],
    detect: [UNIT('src/config/env.validation.spec.ts')],
  },
  {
    id: 'M81',
    what: 'a failed attempt is treated as the last one (no retries)',
    file: BULL,
    edits: [
      ['const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);', 'const last = true;'],
    ],
    detect: [QUEUE('bull-job-queue.queue-spec.ts')],
  },
  {
    id: 'M82',
    what: 'a "no" with a number in it ("gak 5rb") cancels a pending question',
    file: YESNO,
    edits: [
      [
        'if (tokens.some((t) => /\\d/.test(t))) return null;',
        'if (Date.now() < 0 && tokens.some((t) => /\\d/.test(t))) return null;',
      ],
    ],
    detect: [UNIT('src/modules/bot/application/yes-no.spec.ts')],
  },
  {
    id: 'M83',
    what: 'a long run of yes words counts as a confirmation (no length cap)',
    file: YESNO,
    edits: [
      [
        'if (tokens.length === 0 || tokens.length > MAX_REPLY_TOKENS) return null;',
        'if (tokens.length === 0 || (Date.now() < 0 && tokens.length > MAX_REPLY_TOKENS)) return null;',
      ],
    ],
    detect: [UNIT('src/modules/bot/application/yes-no.spec.ts')],
  },
  {
    id: 'M84',
    what: 'any sentence containing "ya" confirms (filler-only rule removed)',
    file: YESNO,
    edits: [
      [
        'tokens.every((t) => YES_WORDS.has(t) || YES_FILLER.has(t))',
        '(tokens.every((t) => YES_WORDS.has(t) || YES_FILLER.has(t)) || true)',
      ],
    ],
    detect: [UNIT('src/modules/bot/application/yes-no.spec.ts')],
  },
  {
    id: 'M85',
    what: '"ganti 2 ban motor 300rb" is an edit of the last transaction',
    file: PARSER,
    edits: [
      [
        'return /^(rp\\.?)?\\d/.test(rest[0]) && rest.every(plain);',
        'return /^(rp\\.?)?\\d/.test(rest[0]) && (rest.every(plain) || true);',
      ],
    ],
    detect: [UNIT('src/modules/parser/rule-based/rule-based.parser.spec.ts')],
  },
  {
    id: 'M86',
    what: 'a help word inside an expense shows help instead of recording it',
    file: PARSER,
    edits: [['&& !/\\d/.test(raw)) {', ') {']],
    detect: [UNIT('src/modules/parser/rule-based/rule-based.parser.spec.ts')],
  },
  {
    id: 'M87',
    what: 'a recovered receipt job anchors the draft lifetime on the SEND time (born expired after an outage)',
    file: JOB_HANDLER,
    edits: [['timestamp: new Date(),', 'timestamp: new Date(job.receivedAt),']],
    detect: [UNIT('src/modules/bot/application/receipt-job.spec.ts')],
  },
  {
    id: 'M88',
    what: 'the integrity gate passes when the checks return fewer rows than defined (or none)',
    file: LIBDB,
    edits: [['if [ "$got" -lt "$expected" ]; then', 'if false; then']],
    detect: [FAILURE('backup-recovery.failure-spec.ts')],
  },
  {
    id: 'M89',
    what: 'a reset phrase anywhere in an expense opens the wipe prompt',
    file: PARSER,
    edits: [['ordered.length <= 4 &&', '']],
    detect: [UNIT('src/modules/parser/rule-based/rule-based.parser.spec.ts')],
  },
  {
    id: 'M90',
    what: 'updates of one chat are processed concurrently instead of one at a time, in order',
    file: 'src/modules/bot/infrastructure/update-processor.ts',
    edits: [
      [
        'const previous = this.chats.get(key) ?? Promise.resolve();',
        'const previous = Promise.resolve();',
      ],
    ],
    detect: [UNIT('src/modules/bot/infrastructure/update-processor.spec.ts')],
  },
  {
    id: 'M91',
    what: "the duplicate-receipt check also matches other users' expenses",
    file: RECEIPT_REPO,
    edits: [
      [
        "        userId,\n        type: 'EXPENSE',",
        "        ...(userId ? {} : { userId }),\n        type: 'EXPENSE',",
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M92',
    what: 'the duplicate-receipt check also matches deleted expenses',
    file: RECEIPT_REPO,
    edits: [
      [
        '        deletedAt: null,\n        occurredAt: { gte: from, lt: to },',
        '        occurredAt: { gte: from, lt: to },',
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M93',
    what: 'a stale possible-duplicate flag stays on the draft after the user corrects the receipt',
    file: RECEIPT_SVC,
    edits: [
      [
        "warnings: exists ? [...rest, 'POSSIBLE_DUPLICATE'] : rest }",
        "warnings: exists ? [...rest, 'POSSIBLE_DUPLICATE'] : extraction.warnings }",
      ],
    ],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M94',
    what: 'a new receipt photo is never compared with the expenses already recorded',
    file: RECEIPT_SVC,
    edits: [
      [
        'const extraction = await this.flagPossibleDuplicate(user, outcome.extraction, now);',
        'const extraction = outcome.extraction;',
      ],
    ],
    detect: [INT('receipt.spec.ts'), E2E('receipt.e2e-spec.ts')],
  },
  {
    id: 'M95',
    what: "the duplicate-receipt window is a whole year instead of the receipt's day",
    file: RECEIPT_SVC,
    edits: [["from.add(1, 'day').toDate()", "from.add(1, 'year').toDate()"]],
    detect: [INT('receipt.spec.ts')],
  },
  {
    id: 'M96',
    what: 'the webhook secret header is no longer removed from log lines',
    file: 'src/common/logger/logger.module.ts',
    edits: [['  \'req.headers["x-telegram-bot-api-secret-token"]\',\n', '']],
    detect: [UNIT('src/common/logger/logger.module.spec.ts')],
  },
  {
    id: 'M97',
    what: 'responses announce the framework (x-powered-by)',
    file: 'src/app.setup.ts',
    edits: [["server.disable?.('x-powered-by');", "server.disable?.('etag');"]],
    detect: [E2E('bot.e2e-spec.ts')],
  },
];

const norm = (s) => s.replace(/\r\n/g, '\n');

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-bot-mut-'));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.startsWith('docs/') && fs.existsSync(path.join(REPO, f)));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  // The guarded test database settings live in .env (git-ignored): copy it into the temp copy only.
  if (fs.existsSync(path.join(REPO, '.env')))
    fs.copyFileSync(path.join(REPO, '.env'), path.join(dir, '.env'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

function removeCopy(dir) {
  // the link first: removing it must never touch the real node_modules
  try {
    fs.rmdirSync(path.join(dir, 'node_modules'));
  } catch {
    fs.unlinkSync(path.join(dir, 'node_modules'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs one test command in the copy and classifies the outcome from Jest's own JSON report:
 *   assertion : a test failed on an expect(...) assertion (a meaningful detection)
 *   error     : a test failed with a thrown error, not an assertion (the application broke in a way the
 *               test expected to surface, e.g. a unique violation) - a detection, but weaker evidence
 *   timeout   : a test or the whole command ran out of time
 *   crash     : no readable report and no compile error (out of memory, endless loop, killed)
 *   invalid   : the mutant did not compile (it proves nothing)
 *   passed    : every test passed (the mutant was NOT noticed by this command)
 */
function run(work, { cmd, env }) {
  const report = path.join(work, `jest-report-${process.pid}-${Date.now()}.json`);
  const r = spawnSync(`${cmd} --json --outputFile=${JSON.stringify(report)}`, {
    shell: true,
    cwd: work,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: TIMEOUT_MS,
  });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const summary =
    (out.match(/^Tests:.*$/gm) || []).join(' | ') ||
    (r.error ? `no result (${r.error.code ?? r.error.message})` : 'no result');
  const timedOut = r.error?.code === 'ETIMEDOUT';

  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch {
    json = null;
  }
  try {
    fs.rmSync(report, { force: true });
  } catch {
    /* ignore */
  }

  const failures = [];
  let suiteFailed = false;
  for (const suite of json?.testResults ?? []) {
    const failedTests = (suite.assertionResults ?? []).filter((t) => t.status === 'failed');
    for (const t of failedTests) failures.push((t.failureMessages ?? []).join('\n'));
    if (suite.status === 'failed' && failedTests.length === 0) suiteFailed = true;
  }
  const compileError = suiteFailed || /Test suite failed to run|error TS\d+/.test(out);

  let kind = 'passed';
  if (timedOut) kind = 'timeout';
  else if (compileError && failures.length === 0) kind = 'invalid';
  else if (failures.length > 0) {
    // A failing assertion is the strongest evidence even when another test in the same run timed out.
    const isTimeout = (m) => /Exceeded timeout|timed out/i.test(m);
    if (failures.some((m) => /expect\(|Expected|Received|expected \d+ /.test(m) && !isTimeout(m))) {
      kind = 'assertion';
    } else if (failures.some(isTimeout)) kind = 'timeout';
    else kind = 'error';
  } else if (!json) kind = 'crash';
  return { kind, tests: summary, failedTests: failures.length };
}

const work = makeCopy();
// The copy holds a copy of .env: remove it even when the run is interrupted (Ctrl+C, terminal closed).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      if (!process.env.KEEP_COPY) removeCopy(work);
    } finally {
      process.exit(130);
    }
  });
}
const results = [];
try {
  // Baseline: the unmutated copy must pass, or the results mean nothing.
  const baselineCmds = [
    ...new Map(MUTANTS.flatMap((m) => m.detect).map((d) => [d.cmd, d])).values(),
  ];
  for (const d of baselineCmds) {
    if (only || process.env.DRY) break; // a quick subset run trusts the full run's baseline
    const r = run(work, d);
    if (r.kind !== 'passed') {
      console.error(
        `BASELINE FAILS (${d.cmd}): ${r.kind}, ${r.tests}. Fix the suite before mutating.`,
      );
      process.exitCode = 2;
      throw new Error('baseline');
    }
  }
  console.log(
    only
      ? 'Subset run: baseline not re-checked.\n'
      : `Baseline green for ${baselineCmds.length} test commands.\n`,
  );

  for (const m of MUTANTS) {
    if (only && !only.has(m.id)) continue;
    const target = path.join(work, m.file);
    const original = norm(fs.readFileSync(path.join(REPO, m.file), 'utf8'));
    let mutated = original;
    let applicable = true;
    for (const [from, to] of m.edits) {
      if (!mutated.includes(from)) {
        applicable = false;
        break;
      }
      mutated = mutated.replace(from, () => to);
    }
    if (!applicable) {
      results.push({
        id: m.id,
        what: m.what,
        verdict: 'NOT APPLICABLE (source text changed; update the mutant)',
      });
      console.log(`${m.id.padEnd(5)} NOT APPLICABLE  ${m.what}`);
      continue;
    }
    if (process.env.DRY) {
      // DRY=1 only proves every mutant still applies to the current source (no tests are run).
      results.push({ id: m.id, what: m.what, verdict: 'APPLICABLE (dry run)', notes: [] });
      console.log(`${m.id.padEnd(5)} APPLICABLE       ${m.what}`);
      continue;
    }
    fs.writeFileSync(target, mutated);
    // Strongest evidence wins: assertion > error > timeout > crash. 'invalid' is never a kill.
    const RANK = { assertion: 4, error: 3, timeout: 2, crash: 1 };
    let best = null;
    let invalid = 0;
    const notes = [];
    try {
      for (const d of m.detect) {
        const r = run(work, d);
        notes.push(
          `${d.cmd.replace(/^npx jest( --config \S+)?( --runInBand)? ?/, '')}: ${r.kind} (${r.tests})`,
        );
        if (r.kind === 'invalid') invalid += 1;
        if (RANK[r.kind] && (!best || RANK[r.kind] > RANK[best])) best = r.kind;
        if (r.kind === 'assertion') break; // a meaningful detection is enough
      }
    } finally {
      fs.writeFileSync(target, fs.readFileSync(path.join(REPO, m.file)));
    }
    let verdict;
    if (best === 'assertion') verdict = 'KILLED (assertion)';
    else if (best === 'error') verdict = 'KILLED (application error, no assertion)';
    else if (best === 'timeout') verdict = 'KILLED (timeout only)';
    else if (best === 'crash') verdict = 'KILLED (test run crashed: unrelated evidence)';
    else if (invalid === m.detect.length) verdict = 'INVALID (mutant does not compile)';
    else if (m.equivalent) verdict = 'EQUIVALENT (documented)';
    else verdict = 'SURVIVED';
    results.push({ id: m.id, what: m.what, verdict, notes });
    console.log(`${m.id.padEnd(5)} ${verdict.padEnd(46)} ${m.what}`);
  }
} catch (err) {
  if (!(err instanceof Error && err.message === 'baseline')) throw err;
} finally {
  if (process.env.KEEP_COPY) console.log(`Copy kept at ${work}`);
  else removeCopy(work);
}

const count = (prefix) => results.filter((r) => r.verdict.startsWith(prefix)).length;
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const summary = {
  total: results.length,
  killedByAssertion: count('KILLED (assertion)'),
  killedByApplicationError: count('KILLED (application error'),
  killedByTimeoutOnly: count('KILLED (timeout'),
  killedByUnrelatedCrash: count('KILLED (test run crashed'),
  invalidMutants: count('INVALID'),
  equivalent: count('EQUIVALENT'),
  notApplicable: count('NOT APPLICABLE'),
  survived: survived.length,
};
console.log('\nSummary: ' + JSON.stringify(summary, null, 2));
console.log(
  'Only "KILLED (assertion)" counts as meaningful detection; the other kill kinds are weaker evidence.',
);
for (const sv of survived)
  console.log(`  SURVIVED ${sv.id}: ${sv.what}\n    ${sv.notes.join('\n    ')}`);
fs.writeFileSync(
  path.join(REPO, 'mutation-report.json'),
  JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2),
);
if (survived.length > 0 || summary.notApplicable > 0 || summary.invalidMutants > 0)
  process.exitCode = 1;
