import { Module } from '@nestjs/common';
import { ConversationService } from './application/conversation.service';
import { ConversationRepository } from './domain/conversation.repository';
import { PrismaConversationRepository } from './infrastructure/prisma-conversation.repository';

@Module({
  providers: [
    { provide: ConversationRepository, useClass: PrismaConversationRepository },
    ConversationService,
  ],
  exports: [ConversationRepository, ConversationService],
})
export class ConversationModule {}
