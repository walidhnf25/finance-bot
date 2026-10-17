export type AuditMetadata = Record<string, unknown>;

export interface AuditLogEntity {
  id: string;
  userId: string | null;
  action: string;
  metadata: AuditMetadata | null;
  createdAt: Date;
}

export interface RecordAuditInput {
  userId?: string | null;
  action: string;
  metadata?: AuditMetadata | null;
}
