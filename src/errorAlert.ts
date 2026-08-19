import axios from 'axios';
import { error } from './log';

export interface WebhookConfig {
    enabled?: boolean;
    webhook_url?: string;
}

export function getErrorType(err: any): string {
    if (!err) return 'UnknownError';
    if (typeof err === 'string') return err;
    if (err instanceof Error || (typeof err === 'object' && (err.name || err.message))) {
        const name = err.name || 'Error';
        const message = err.message || String(err);
        return `${name}: ${message}`;
    }
    return String(err);
}

let lastErrorType: string | null = null;
let consecutiveCount: number = 0;
const lastNotificationTimeMap = new Map<string, number>();

export function resetAlertState() {
    lastErrorType = null;
    consecutiveCount = 0;
    lastNotificationTimeMap.clear();
}

export function getAlertState() {
    return {
        lastErrorType,
        consecutiveCount,
        lastNotificationTimeMap: new Map(lastNotificationTimeMap)
    };
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function handleUnhandledError(
    err: any,
    webhookConfig?: WebhookConfig
): Promise<boolean> {
    const errorType = getErrorType(err);

    if (errorType === lastErrorType) {
        consecutiveCount++;
    } else {
        lastErrorType = errorType;
        consecutiveCount = 1;
    }

    if (!webhookConfig?.enabled || !webhookConfig?.webhook_url) {
        return false;
    }

    // Trigger ONLY after the exact same type of error occurs more than 5 consecutive times
    if (consecutiveCount <= 5) {
        return false;
    }

    const now = Date.now();
    const lastSent = lastNotificationTimeMap.get(errorType) || 0;

    if (lastSent > 0 && now - lastSent < ONE_HOUR_MS) {
        return false;
    }

    lastNotificationTimeMap.set(errorType, now);

    const payload = {
        content: `🚨 **Unhandled Exception Alert**`,
        embeds: [
            {
                title: 'Unhandled Error/Exception',
                description: errorType.slice(0, 2000),
                color: 16711680,
                fields: [
                    {
                        name: 'Consecutive Occurrences',
                        value: String(consecutiveCount),
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        await axios.post(webhookConfig.webhook_url, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        return true;
    } catch (e: any) {
        error('Failed to dispatch error webhook notification:', e?.message || e);
        return false;
    }
}
