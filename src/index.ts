import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, Context, Next } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import amqp from 'amqplib';
import Redis, { Command } from 'ioredis';

import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import os from 'os';

import beforeShutdown from './beforeShutdown';
import { error, log, warn } from './log';
import { robloxRanges } from './robloxRanges';
import { RabbitMQClient } from './rmq';
import { handleUnhandledError, sendStartupAlert } from './errorAlert';

const VERSION = (() => {
    const rev = fs.readFileSync('.git/HEAD').toString().trim();
    if (rev.indexOf(':') === -1) {
        return rev;
    } else {
        return fs
            .readFileSync('.git/' + rev.substring(5))
            .toString()
            .trim()
            .slice(0, 7);
    }
})();

function formatNumberWithUnderscores(val: number | string): string {
    const numStr = String(val);
    if (!/^\d+$/.test(numStr)) return numStr;
    return numStr.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

const app = new Hono();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as {
    port: number;
    trustProxy: boolean;
    autoBlock: boolean;
    queue: {
        enabled: boolean;
        rabbitmq: string;
        queue: string;
    };
    redis: string;
    abuseThreshold: number;
    webhook?: {
        enabled?: boolean;
        webhook_url?: string;
    };
    stats_since?: string;
};

const STATS_SINCE = config.stats_since && config.stats_since.trim() ? config.stats_since.trim() : new Date().toISOString();

const adapter = new PrismaBetterSqlite3({ url: 'file:./proxy.db' });
const db = new PrismaClient({ adapter });

const redis = new Redis(config.redis, {
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
        const delay = Math.min(times * 100, 3000);
        warn(`[ioredis] Redis connection retry attempt ${times}, delaying ${delay}ms`);
        return delay;
    }
});

// Prevent the process from crashing on Redis connection errors
redis.on('error', (err) => {
    error('[ioredis] Redis Client Error:', err);
    handleUnhandledError(err, config.webhook, { immediate: true });
});

beforeShutdown(async () => {
    await db.$disconnect();
    redis.disconnect(false);
});

type AxiosClientTuple = [client: AxiosInstance, ip: string];
const axiosClients: AxiosClientTuple[] = [];

let currentRobin = 0;
function client(): AxiosClientTuple {
    const instance = axiosClients[currentRobin];

    currentRobin++;
    if (currentRobin === axiosClients.length) currentRobin = 0;

    return instance;
}

let currentSafeRobin = 0;
async function clientSafe(): Promise<AxiosClientTuple | null> {
    if (axiosClients.length === 0) return null;
    const startRobin = currentSafeRobin;

    while (true) {
        const instance = axiosClients[currentSafeRobin];
        currentSafeRobin = (currentSafeRobin + 1) % axiosClients.length;

        const abuse = parseInt((await redis.get(`clientAbuse:${instance[1]}`)) || '0');
        if (abuse < config.abuseThreshold) {
            return instance;
        }

        if (currentSafeRobin === startRobin) break;
    }

    return null;
}

async function getClient(webhookId: string) {
    if (!(await redis.get(`webhooksSeen:${webhookId}`)) || (await redis.get(`webhooksSeen:${webhookId}`)) === 'false') {
        return clientSafe();
    } else {
        return client();
    }
}

function discoverIPs() {
    const discovered: string[] = [];
    for (const [_, iface] of Object.entries(os.networkInterfaces())) {
        if (!iface) continue;
        for (const net of iface) {
            if (net.internal || net.family !== 'IPv4') continue;
            discovered.push(net.address);
        }
    }
    return discovered;
}

function updateAxiosClients() {
    const currentIPs = discoverIPs();
    const existingIPs = axiosClients.map(c => c[1]);

    // Add new IPs
    for (const ip of currentIPs) {
        if (!existingIPs.includes(ip)) {
            axiosClients.push([
                axios.create({
                    httpsAgent: new https.Agent({
                        // @ts-ignore - undocumented
                        localAddress: ip
                    }),
                    headers: {
                        'User-Agent': 'WebhookProxy/1.0 (https://github.com/slord399/discord_webhook_proxy)'
                    },
                    validateStatus: () => true,
                    timeout: 30000
                }),
                ip
            ]);
            log('Discovered new IP address', ip);
        }
    }

    // Remove old IPs (optional, but keep it simple for now)
    for (let i = axiosClients.length - 1; i >= 0; i--) {
        if (!currentIPs.includes(axiosClients[i][1])) {
            warn('IP address lost:', axiosClients[i][1]);
            axiosClients.splice(i, 1);
        }
    }

    if (axiosClients.length === 0) {
        warn('No outbound IP addresses discovered! Requests will likely fail.');
    }
}

updateAxiosClients();
setInterval(updateAxiosClients, 60 * 60 * 1000); // Refresh every hour

let rabbitMqClient: RabbitMQClient | null = null;

let requestsHandled = 0;

async function banWebhook(id: string, reason: string, gameId?: string) {
    await redis.set(`webhookBan:${id}`, reason, 'EX', 24 * 60 * 60);
    await db.bannedWebhook.upsert({
        where: {
            id
        },
        create: {
            id,
            reason
        },
        update: {
            reason
        }
    });

    warn('banned', formatId(id, gameId!), 'for', reason);
}

async function banIp(ip: string, reason: string) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 3); // 3-day ban

    const hash = crypto.createHash('sha1').update(ip).digest('hex');

    await redis.set(`ipBan:${hash}`, JSON.stringify({ reason, expires: expiry }), "PXAT", expiry.getTime());
    await db.bannedIP.upsert({
        where: {
            id: ip
        },
        create: {
            id: ip,
            reason,
            expires: expiry
        },
        update: {
            reason
        }
    });

    warn('banned', ip, 'for', reason);
}

async function trackBadRequest(id: string, gameId?: string) {
    const violations = await redis.incr(`badRequests:${id}`);
    await redis.sendCommand(new Command('EXPIRE', [`badRequests:${id}`, 600, 'NX']));

    warn(formatId(id, gameId!), 'made a bad request, they have made', violations, 'within the window');

    if (violations > 30 && config.autoBlock) {
        await banWebhook(id, '[Automated] >30 bad requests within 10 minutes.', gameId);
        await redis.del(`badRequests:${id}`);
    }

    return violations;
}

async function trackNonExistentWebhook(ip: string, clientAddress: string) {
    if (ip === 'localhost' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return; //ignore ourselves

    const hash = crypto.createHash('sha1').update(ip).digest('hex');

    const violations = await redis.incr(`nonExistentWebhooks:${hash}`);
    await redis.sendCommand(new Command('EXPIRE', [`nonExistentWebhooks:${hash}`, 3600, 'NX']));

    await redis.incr('nonExistentWebhooks');
    await redis.sendCommand(new Command('EXPIRE', ['nonExistentWebhooks', 86400, 'NX']));

    warn(ip, 'made a request to a nonexistent webhook, they have done so', violations, 'time within the window');

    await redis.incr(`clientAbuse:${clientAddress}`);
    await redis.sendCommand(new Command('EXPIRE', [`clientAbuse:${clientAddress}`, 86400, 'NX']));

    if (violations > 2 && config.autoBlock) {
        await banIp(ip, '[Automated] >2 unique non-existent webhook requests within 1 hour.');
        await redis.del(`nonExistentWebhooks:${hash}`);
    }

    return violations;
}

async function trackInvalidWebhookToken(ip: string) {
    if (ip === 'localhost' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return; //ignore ourselves

    const hash = crypto.createHash('sha1').update(ip).digest('hex');

    const violations = await redis.incr(`invalidWebhookToken:${hash}`);
    await redis.sendCommand(new Command('EXPIRE', [`invalidWebhookToken:${hash}`, 3600, 'NX']));

    await redis.incr('invalidWebhookToken');
    await redis.sendCommand(new Command('EXPIRE', ['invalidWebhookToken', 86400, 'NX']));

    warn(
        ip,
        'made a request to a webhook with an invalid token, they have done so',
        violations,
        'times within the window'
    );

    if (violations > 10 && config.autoBlock) {
        await banIp(ip, '[Automated] >10 invalid webhook token requests within 1 hour.');
        await redis.del(`invalidWebhookToken:${hash}`);
    }

    return violations;
}

async function getWebhookBanInfo(id: string): Promise<string | undefined> {
    const data = await redis.get(`webhookBan:${id}`);
    if (data) {
        return data;
    }

    const ban = await db.bannedWebhook.findUnique({
        where: {
            id
        }
    });

    await redis.set(`webhookBan:${id}`, ban?.reason ?? '', 'EX', 24 * 60 * 60);

    return ban?.reason;
}

async function getGameBanInfo(id: string): Promise<string | undefined> {
    const data = await redis.get(`gameBan:${id}`);
    if (data) {
        return data;
    }

    const ban = await db.bannedGame.findUnique({
        where: {
            id
        }
    });

    await redis.set(`gameBan:${id}`, ban?.reason ?? '', 'EX', 24 * 60 * 60);

    return ban?.reason;
}

async function getIPBanInfo(ip: string): Promise<{ reason: string; expires: Date } | null> {
    if (ip === 'localhost' || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return null; //ignore ourselves

    const hash = crypto.createHash('sha1').update(ip).digest('hex');

    const data = await redis.get(`ipBan:${hash}`);
    if (data) {
        const ban = JSON.parse(data);
        if (ban === null) return null;
        return { reason: ban.reason, expires: new Date(ban.expires) };
    }

    const ban = await db.bannedIP.findUnique({
        where: {
            id: ip
        },
        select: {
            reason: true,
            expires: true
        }
    });

    if (ban) {
        if (ban.expires.getTime() <= Date.now()) {
            await db.bannedIP.deleteMany({
                where: {
                    id: ip
                }
            });
            await redis.del(`ipBan:${hash}`);
            return null;
        }
    }

    await redis.set(
        `ipBan:${hash}`,
        JSON.stringify(ban),
        'PXAT',
        ban?.expires.getTime() ?? Date.now() + 24 * 60 * 60 * 1000
    );

    return ban as { reason: string; expires: Date } | null;
}

function formatId(id: string, gameId?: string) {
    if (gameId) {
        return `${id} (belonging to ${gameId})`;
    } else {
        return id;
    }
}

const getIP = (c: Context): string => {
    if (config.trustProxy) {
        const xff = c.req.header('x-forwarded-for');
        if (xff) {
            return xff.split(',')[0].trim();
        }
        const xri = c.req.header('x-real-ip');
        if (xri) {
            return xri;
        }
    }
    return getConnInfo(c).remote.address || '127.0.0.1';
};

app.use('*', secureHeaders());

interface RateLimitConfig {
    prefix: string;
    windowMs: number;
    max?: number;
    delayAfter?: number;
    delayMs?: (used: number) => number;
    maxDelayMs?: number;
    keyGenerator?: (c: Context) => string;
    skip?: (c: Context) => boolean;
}

function createLimiter(opts: RateLimitConfig) {
    const {
        prefix,
        windowMs,
        max,
        delayAfter,
        delayMs = (used) => (used - (delayAfter || 0)) * 1000,
        maxDelayMs = 30000,
        keyGenerator = (c) => c.req.param('id') || getIP(c),
        skip = () => false
    } = opts;

    return async (c: Context, next: Next) => {
        if (skip(c)) {
            return await next();
        }

        const key = `ratelimit:${prefix}:${keyGenerator(c)}`;

        const results = await redis.multi()
            .incr(key)
            .ttl(key)
            .exec();

        if (!results) {
            return await next();
        }

        const count = results[0][1] as number;
        const ttl = results[1][1] as number;

        if (ttl === -1) {
            await redis.expire(key, Math.ceil(windowMs / 1000));
        }

        if (max !== undefined && count > max) {
            c.status(429);
            return c.json({
                proxy: true,
                error: 'Too many requests, please try again later.'
            });
        }

        if (delayAfter !== undefined && count > delayAfter) {
            const delay = Math.min(delayMs(count), maxDelayMs);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        await next();
    };
}

const webhookPostRatelimit = createLimiter({
    prefix: 'webhookPost',
    windowMs: 2000,
    delayAfter: 5
});

const webhookQueuePostRatelimit = createLimiter({
    prefix: 'webhookQueue',
    windowMs: 1000,
    delayAfter: 10
});

const statsEndpointRatelimit = createLimiter({
    prefix: 'statsEndpoint',
    windowMs: 5000,
    delayAfter: 1,
    delayMs: (used) => (used - 1) * 500
});

const announcementEndpointRatelimit = createLimiter({
    prefix: 'announcementEndpoint',
    windowMs: 15 * 60 * 1000,
    max: 5000
});

const webhookInvalidPostRatelimit = async (c: Context, next: Next) => {
    const id = c.req.param('id') || getIP(c);
    const key = `ratelimit:webhookInvalidPost:${id}`;

    const violations = parseInt((await redis.get(key)) || '0');
    if (violations > 3) {
        const delay = Math.min((violations - 3) * 1000, 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await next();

    if (c.res.status >= 400 && c.res.status < 500 && c.res.status !== 429) {
        const results = await redis.multi()
            .incr(key)
            .ttl(key)
            .exec();

        if (results) {
            const ttl = results[1][1] as number;
            if (ttl === -1) {
                await redis.expire(key, 30);
            }
        }
    }
};

app.use('/*', serveStatic({ root: './public' }));

app.get('/stats', statsEndpointRatelimit, async (c) => {
    const data = await Promise.all([
        (async () => parseInt((await redis.get('stats:requests')) ?? '0', 10))(),
        db.webhooksSeen.count()
    ]);

    const getRedisStatus = (): 'connected' | 'reconnecting' | 'disconnected' => {
        const st = redis.status;
        if (st === 'ready' || st === 'connect') return 'connected';
        if (st === 'reconnecting' || st === 'connecting') return 'reconnecting';
        return 'disconnected';
    };

    const rmqStatus = config.queue.enabled
        ? (rabbitMqClient ? rabbitMqClient.getStatus() : 'disconnected')
        : 'disabled';

    const decimalVersion = isNaN(parseInt(VERSION, 16)) ? VERSION : parseInt(VERSION, 16);

    return c.json({
        requests: formatNumberWithUnderscores(data[0]),
        webhooks: Number(data[1]),
        version: formatNumberWithUnderscores(decimalVersion),
        stats_since: STATS_SINCE,
        services: {
            rabbitmq: rmqStatus,
            redis: getRedisStatus()
        }
    });
});

app.get('/announcement', announcementEndpointRatelimit, async (c) => {
    const announcement = await redis.hgetall('announcement');

    if (!announcement.style) {
        return c.json({});
    }

    return c.json({
        title: announcement['title'],
        message: announcement['message'],
        style: announcement['style']
    });
});

async function preRequestChecks(c: Context, id: string, ip: string, gameId?: string) {
    const ipBan = await getIPBanInfo(ip);
    if (ipBan) {
        warn('ip', ip, 'attempted to request to', id, 'whilst banned');
        c.status(403);
        return c.json({
            proxy: true,
            message: 'This IP address has been banned.',
            reason: ipBan.reason,
            expires: ipBan.expires.getTime()
        });
    }

    if (gameId) {
        const gameBan = await getGameBanInfo(gameId);
        if (gameBan) {
            warn('game', gameId, 'attempted to request to', id, 'whilst banned');
            c.status(403);
            return c.json({
                proxy: true,
                message: 'This game has been banned.',
                reason: gameBan
            });
        }
    }

    const banInfo = await getWebhookBanInfo(id);
    if (banInfo) {
        warn(formatId(id, gameId), 'attempted to request whilst blocked for', banInfo);
        c.status(403);
        return c.json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @lewisakura on the DevForum.',
            reason: banInfo
        });
    }

    const ratelimitStr = await redis.get(`webhookRatelimit:${id}`);
    const ratelimit = ratelimitStr ? parseInt(ratelimitStr) : NaN;
    if (ratelimit === 0) {
        const ttl = Math.floor(Date.now() / 1000) + await redis.ttl(`webhookRatelimit:${id}`);

        c.header('X-RateLimit-Limit', '5');
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', ttl.toString());

        c.status(429);
        return c.json({
            proxy: true,
            message: 'You have been ratelimited. Please respect the standard Discord ratelimits.'
        });
    }

    if (!(await redis.exists(`webhooksSeen:${id}`))) {
        await redis.set(
            `webhooksSeen:${id}`,
            (!!(await db.webhooksSeen.findFirst({ where: { id } }))).toString()
        );
        await redis.sendCommand(new Command('EXPIRE', [`webhooksSeen:${id}`, 600, 'NX']));
    }

    return null;
}

async function postRequestChecks(
    c: Context,
    id: string,
    ip: string,
    response: AxiosResponse<any>,
    clientAddress: string,
    gameId?: string
) {
    if (response.status === 401 && response.data?.code === 50027 /* invalid webhook token */) {
        await trackInvalidWebhookToken(ip);

        c.status(401);
        return c.json({
            proxy: true,
            error: 'The authorization token for this webhook is invalid.'
        });
    }

    if (response.status === 404 && response.data?.code === 10015 /* webhook not found */) {
        await db.bannedWebhook.upsert({
            where: { id },
            create: {
                id,
                reason: '[Automated] Webhook does not exist.'
            },
            update: {
                reason: '[Automated] Webhook does not exist.'
            }
        });

        await trackNonExistentWebhook(ip, clientAddress);

        c.status(404);
        return c.json({
            proxy: true,
            error: 'This webhook does not exist.'
        });
    }

    if (
        !(await redis.exists(`webhooksSeen:${id}`)) ||
        (await redis.get(`webhooksSeen:${id}`)) === 'false'
    ) {
        await redis.set(`webhooksSeen:${id}`, 'true');
        await redis.sendCommand(new Command('EXPIRE', [`webhooksSeen:${id}`, 600, 'NX']));

        await db.webhooksSeen.upsert({ where: { id }, update: {}, create: { id } });
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        await trackBadRequest(id, gameId);
    }

    if (response.headers['x-ratelimit-remaining'] && response.headers['x-ratelimit-reset']) {
        await redis.set(
            `webhookRatelimit:${id}`,
            response.headers['x-ratelimit-remaining'],
            'EXAT',
            parseInt(response.headers['x-ratelimit-reset'])
        );
    }

    return null;
}

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, webhookInvalidPostRatelimit, async (c) => {
    await redis.incr('stats:requests');
    requestsHandled++;

    const id = c.req.param('id');
    const token = c.req.param('token');

    try {
        BigInt(id);
    } catch {
        c.status(400);
        return c.json({
            proxy: true,
            error: 'Webhook ID does not appear to be a snowflake.'
        });
    }

    const ip = getIP(c);
    const gameId = robloxRanges.check(ip) ? c.req.header('roblox-id') : undefined;

    const preChecksResult = await preRequestChecks(c, id, ip, gameId);
    if (preChecksResult) return preChecksResult;

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        c.status(400);
        return c.json({
            proxy: true,
            error: 'No body provided. The proxy only accepts valid JSON bodies.'
        });
    }

    if (!body || typeof body !== 'object' || (!body.content && !body.embeds && !body.file)) {
        c.status(400);
        return c.json({
            proxy: true,
            error: 'No body provided. The proxy only accepts valid JSON bodies.'
        });
    }

    const wait = c.req.query('wait') ?? 'false';
    const threadId = c.req.query('thread_id');

    const clientTuple = await getClient(id);

    if (!clientTuple) {
        c.status(403);
        return c.json({
            proxy: true,
            error: 'The proxy has not seen your webhook before, and is currently unable to service your request.'
        });
    }

    let response: AxiosResponse<any>;
    try {
        response = await clientTuple[0].post(
            `https://discord.com/api/webhooks/${id}/${token}?wait=${wait}${
                threadId ? '&thread_id=' + threadId : ''
            }`,
            body,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (e: any) {
        error('Failed to forward request to Discord:', e.message ?? e);
        c.status(502);
        return c.json({
            proxy: true,
            error: 'Failed to forward request to Discord.',
            details: e.message
        });
    }

    const postChecksResult = await postRequestChecks(c, id, ip, response, clientTuple[1], gameId);
    if (postChecksResult) return postChecksResult;

    for (const header of Object.keys(response.headers)) {
        if (header.toLowerCase() === 'transfer-encoding') continue;
        c.header(header, response.headers[header]);
    }

    c.header('Via', '1.0 WebhookProxy');
    c.status(response.status as any);
    return c.json(response.data);
});

app.patch(
    '/api/webhooks/:id/:token/messages/:messageId',
    webhookPostRatelimit,
    webhookInvalidPostRatelimit,
    async (c) => {
        await redis.incr('stats:requests');
        requestsHandled++;

        const id = c.req.param('id');
        const token = c.req.param('token');
        const messageId = c.req.param('messageId');

        try {
            BigInt(id);
        } catch {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'Webhook ID does not appear to be a snowflake.'
            });
        }

        try {
            BigInt(messageId);
        } catch {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'Message ID does not appear to be a snowflake.'
            });
        }

        const ip = getIP(c);
        const gameId = robloxRanges.check(ip) ? c.req.header('roblox-id') : undefined;

        const preChecksResult = await preRequestChecks(c, id, ip, gameId);
        if (preChecksResult) return preChecksResult;

        let body: any;
        try {
            body = await c.req.json();
        } catch {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'No body provided. The proxy only accepts valid JSON bodies.'
            });
        }

        if (!body || typeof body !== 'object' || (!body.content && !body.embeds && !body.file)) {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'No body provided. The proxy only accepts valid JSON bodies.'
            });
        }

        const threadId = c.req.query('thread_id');

        const clientTuple = await getClient(id);

        if (!clientTuple) {
            c.status(403);
            return c.json({
                proxy: true,
                error: 'The proxy has not seen your webhook before, and is currently unable to service your request.'
            });
        }

        let response: AxiosResponse<any>;
        try {
            response = await clientTuple[0].patch(
                `https://discord.com/api/webhooks/${id}/${token}/messages/${messageId}${
                    threadId ? '?thread_id=' + threadId : ''
                }`,
                body,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (e: any) {
            error('Failed to forward request to Discord:', e.message ?? e);
            c.status(502);
            return c.json({
                proxy: true,
                error: 'Failed to forward request to Discord.',
                details: e.message
            });
        }

        const postChecksResult = await postRequestChecks(c, id, ip, response, clientTuple[1], gameId);
        if (postChecksResult) return postChecksResult;

        for (const header of Object.keys(response.headers)) {
            if (header.toLowerCase() === 'transfer-encoding') continue;
            c.header(header, response.headers[header]);
        }

        c.header('Via', '1.0 WebhookProxy');
        c.status(response.status as any);
        return c.json(response.data);
    }
);

app.delete(
    '/api/webhooks/:id/:token/messages/:messageId',
    webhookPostRatelimit,
    webhookInvalidPostRatelimit,
    async (c) => {
        await redis.incr('stats:requests');
        requestsHandled++;

        const id = c.req.param('id');
        const token = c.req.param('token');
        const messageId = c.req.param('messageId');

        try {
            BigInt(id);
        } catch {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'Webhook ID does not appear to be a snowflake.'
            });
        }

        try {
            BigInt(messageId);
        } catch {
            c.status(400);
            return c.json({
                proxy: true,
                error: 'Message ID does not appear to be a snowflake.'
            });
        }

        const ip = getIP(c);
        const gameId = robloxRanges.check(ip) ? c.req.header('roblox-id') : undefined;

        const preChecksResult = await preRequestChecks(c, id, ip, gameId);
        if (preChecksResult) return preChecksResult;

        const threadId = c.req.query('thread_id');

        const clientTuple = await getClient(id);

        if (!clientTuple) {
            c.status(403);
            return c.json({
                proxy: true,
                error: 'The proxy has not seen your webhook before, and is currently unable to service your request.'
            });
        }

        let response: AxiosResponse<any>;
        try {
            response = await clientTuple[0].delete(
                `https://discord.com/api/webhooks/${id}/${token}/messages/${messageId}${
                    threadId ? '?thread_id=' + threadId : ''
                }`,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (e: any) {
            error('Failed to forward request to Discord:', e.message ?? e);
            c.status(502);
            return c.json({
                proxy: true,
                error: 'Failed to forward request to Discord.',
                details: e.message
            });
        }

        const postChecksResult = await postRequestChecks(c, id, ip, response, clientTuple[1], gameId);
        if (postChecksResult) return postChecksResult;

        for (const header of Object.keys(response.headers)) {
            if (header.toLowerCase() === 'transfer-encoding') continue;
            c.header(header, response.headers[header]);
        }

        c.header('Via', '1.0 WebhookProxy');
        c.status(response.status as any);
        return c.json(response.data);
    }
);

app.post('/api/webhooks/:id/:token/queue', webhookQueuePostRatelimit, async (c) => {
    if (!config.queue.enabled) {
        c.status(403);
        return c.json({ proxy: true, error: 'Queues have been disabled.' });
    }

    const id = c.req.param('id');
    const token = c.req.param('token');
    const ip = getIP(c);

    const ipBan = await getIPBanInfo(ip);
    if (ipBan) {
        warn('ip', ip, 'attempted to queue to', id, 'whilst banned');
        c.status(403);
        return c.json({
            proxy: true,
            message: 'This IP address has been banned.',
            reason: ipBan.reason,
            expires: ipBan.expires.getTime()
        });
    }

    const gameId = robloxRanges.check(ip) ? c.req.header('roblox-id') : undefined;
    const threadId = c.req.query('thread_id');

    let body: any;
    try {
        body = await c.req.json();
        if (!body || typeof body !== 'object') {
            body = {};
        }
    } catch {
        body = {};
    }

    const reason = await getWebhookBanInfo(id);
    if (reason) {
        warn(formatId(id, gameId), 'attempted to queue whilst blocked for', reason);
        c.status(403);
        return c.json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @lewisakura on the DevForum.',
            reason: reason
        });
    }

    try {
        if (!rabbitMqClient) {
            c.status(503);
            return c.json({
                proxy: true,
                error: 'Queue service connection is currently unavailable. Please try again later.'
            });
        }

        await rabbitMqClient.sendToQueue(
            Buffer.from(
                JSON.stringify({
                    id,
                    token,
                    body,
                    threadId
                })
            ),
            {
                persistent: true
            }
        );

        return c.json({
            proxy: true,
            message: 'Queued successfully.'
        });
    } catch (e: any) {
        error('Failed to queue webhook message:', e?.message || e);
        handleUnhandledError(e, config.webhook, { immediate: true });

        c.status(503);
        return c.json({
            proxy: true,
            error: 'Failed to dispatch message to queue. Broker connection may be restarting.'
        });
    }
});

app.notFound(async (c) => {
    const ip = getIP(c);
    const key = `ratelimit:unknownEndpoint:${ip}`;
    const results = await redis.multi().incr(key).ttl(key).exec();
    if (results) {
        const count = results[0][1] as number;
        const ttl = results[1][1] as number;
        if (ttl === -1) {
            await redis.expire(key, 10);
        }
        if (count > 10) {
            const delay = Math.min((count - 10) * 500, 30000);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    warn(ip, 'hit unknown endpoint');
    c.status(404);
    return c.json({
        proxy: true,
        message: 'Unknown endpoint.'
    });
});

app.onError((err, c) => {
    const id = c.req.param('id') || getIP(c);
    error('error encountered:', err, 'by', id);
    handleUnhandledError(err, config.webhook);

    c.status(500);
    return c.json({
        proxy: true,
        error: 'An error occurred while processing your request.'
    });
});

process.on('uncaughtException', (err) => {
    error('Uncaught Exception:', err);
    handleUnhandledError(err, config.webhook);
});

process.on('unhandledRejection', (reason) => {
    error('Unhandled Rejection:', reason);
    handleUnhandledError(reason, config.webhook);
});

serve({
    fetch: app.fetch,
    port: config.port
}, (info) => {
    log('Up and running. Version:', VERSION, 'on port', info.port);
    sendStartupAlert(config.webhook).catch((err) => {
        error('Startup alert failed:', err);
    });

    setInterval(() => {
        log('In the last minute, this worker handled', requestsHandled, 'requests.');
        requestsHandled = 0;
    }, 60000);

    if (config.queue.enabled) {
        rabbitMqClient = new RabbitMQClient({
            host: config.queue.rabbitmq,
            queue: config.queue.queue,
            onError: (err) => {
                handleUnhandledError(err, config.webhook, { immediate: true });
            }
        });

        beforeShutdown(async () => {
            if (rabbitMqClient) {
                await rabbitMqClient.close();
            }
        });

        rabbitMqClient.connect()
            .then(() => {
                log('RabbitMQ set up with auto-reconnect capability.');
            })
            .catch((e) => {
                error('Initial RabbitMQ connection failed, will retry in background:', e);
                handleUnhandledError(e, config.webhook, { immediate: true });
            });
    }
});
