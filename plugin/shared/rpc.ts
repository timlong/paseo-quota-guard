import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const control = defineRpc({
  name: 'quota.control',
  input: z.object({ action: z.enum(['status', 'refresh', 'pause', 'resume', 'test-push', 'settings', 'codex-credits', 'codex-reset']), accountId: z.string().max(256).optional(),
    creditId: z.string().min(1).max(256).optional(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(), force: z.boolean().optional(),
    settings: z.object({ revision: z.number().int().nonnegative(), enabled: z.boolean(), notifications: z.boolean(),
      thresholds: z.object({ claude: z.object({ warn: z.number(), pause: z.number() }).strict(),
        codex: z.object({ warn: z.number(), pause: z.number() }).strict() }).strict(),
    }).strict().optional(),
  }).strict(),
  output: z.record(z.string(), z.unknown()),
});

export interface Account {
  id: string; provider: string; label: string; fetchedAt: number | null; locked: boolean;
  reason: string; stopStatus: string | null; error: string | null; ready: boolean;
  pauseCause?: 'quota' | 'manual' | 'unavailable' | null;
  errorCode?: 'rate_limited' | 'timeout' | 'unavailable' | 'invalid_data' | 'read_failed' | null;
  stopDetails?: { checkedCount?: number } | null;
  windows: { id: string; used: number; reset: string | null }[];
  assessment: { level: string; canResume: boolean; reason: string; resumeReason?: string | null; usingCachedReading?: boolean };
}
export interface CodexCredits {
  accountId: string | null; planType: string | null; creditBalance: number | null; limitReached: boolean;
  availableCount: number; fetchedAt: number;
  credits: { id: string; title: string | null; grantedAt: number | null; expiresAt: number | null }[];
}
export interface Snapshot {
  enabled: boolean; settingsRevision: number;
  mode: string; notifications: boolean; lastError?: string | null; enforcementReady?: boolean;
  accounts: Account[]; thresholds: Record<string, { warn: number; pause: number }>;
  agents: { id: string; protection: string }[];
  codexCredits?: Record<string, CodexCredits>;
}
