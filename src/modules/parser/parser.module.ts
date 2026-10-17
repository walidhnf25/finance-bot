import { Module } from '@nestjs/common';
import { MessageParser } from './domain/message-parser.port';
import { RuleBasedParser } from './rule-based/rule-based.parser';

/**
 * Binds the MessageParser port to the deterministic rule-based parser. Money amounts are always
 * parsed by rules (never by an AI model); the port stays so another driver could be added later.
 */
@Module({
  providers: [RuleBasedParser, { provide: MessageParser, useExisting: RuleBasedParser }],
  exports: [MessageParser],
})
export class ParserModule {}
