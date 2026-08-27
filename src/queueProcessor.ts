import amqp from 'amqplib';
import axios, { AxiosResponse } from 'axios';
import Redis from 'ioredis';

import fs from 'fs';

import beforeShutdown from './beforeShutdown';
import { error, log, warn } from './log';
import { RabbitMQClient } from './rmq';
import { handleUnhandledError } from './errorAlert';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as {
    port: number;
    queue: {
        enabled: boolean;
        rabbitmq: string;
        queue: string;
    };
    redis: string;
    webhook?: {
        enabled?: boolean;
        webhook_url?: string;
    };
};

const redis = new Redis(config.redis, {
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
        const delay = Math.min(times * 100, 3000);
        warn(`[ioredis] Redis connection retry attempt ${times}, delaying ${delay}ms`);
        return delay;
    }
});

redis.on('error', (err) => {
    error('[ioredis] Redis Client Error:', err);
    handleUnhandledError(err, config.webhook, { immediate: true });
});

process.on('uncaughtException', (err) => {
    error('Uncaught Exception in queueProcessor:', err);
    handleUnhandledError(err, config.webhook, { immediate: true });
});

process.on('unhandledRejection', (reason) => {
    error('Unhandled Rejection in queueProcessor:', reason);
    handleUnhandledError(reason, config.webhook, { immediate: true });
});

const client = axios.create({
    validateStatus: () => true
});

async function run() {
    if (!config.queue.enabled) {
        log('Queue processing is disabled in config. Exiting.');
        process.exit(0);
    }

    const rabbitMqClient = new RabbitMQClient({
        host: config.queue.rabbitmq,
        queue: config.queue.queue,
        onError: (err) => {
            handleUnhandledError(err, config.webhook, { immediate: true });
        }
    });

    beforeShutdown(async () => {
        await rabbitMqClient.close();
    });

    try {
        await rabbitMqClient.connect();
        log('RabbitMQ client connected in processor.');
    } catch (e) {
        error('RabbitMQ initial setup error in processor, will retry in background:', e);
        handleUnhandledError(e, config.webhook, { immediate: true });
    }

    log('Consuming messages from queue.');
    await rabbitMqClient.consume(
        async (msg) => {
            if (!msg) return;
            try {
                const data = JSON.parse(msg.content.toString());

                let isRatelimited = false;
                try {
                    const ratelimitVal = await redis.get(`webhookRatelimit:${data.id}`);
                    if (parseInt(ratelimitVal || 'NaN') === 0) {
                        isRatelimited = true;
                    }
                } catch (e) {
                    warn('Redis check failed during queue processing:', e);
                }

                if (isRatelimited) {
                    return rabbitMqClient.reject(msg);
                }

                let response: AxiosResponse<any>;

                try {
                    response = await client.post(
                        `http://localhost:${config.port}/api/webhooks/${data.id}/${data.token}?wait=false${
                            data.threadId ? '&thread_id=' + data.threadId : ''
                        }`,
                        data.body,
                        {
                            headers: {
                                'User-Agent':
                                    'WebhookProxy-QueueProcessor/1.0 (https://github.com/slord399/discord_webhook_proxy)',
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                } catch (e) {
                    error('Failed to submit webhook to self:', e);
                    return rabbitMqClient.reject(msg);
                }

                if (response.status === 429) return rabbitMqClient.reject(msg);

                if (response.status >= 400 && response.status < 500) {
                    warn(data.id, 'made a bad request');
                }

                rabbitMqClient.ack(msg);
            } catch (err) {
                error('Error processing queue message:', err);
                rabbitMqClient.reject(msg);
            }
        },
        { prefetch: 10 }
    );
}

run();
