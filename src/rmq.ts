import amqp from 'amqplib';
import { error, log, warn } from './log';

export interface RabbitMQOptions {
    host: string;
    queue: string;
    onError?: (err: any) => void;
}

export class RabbitMQClient {
    private host: string;
    private queueName: string;
    private connection: any = null;
    private channel: amqp.Channel | null = null;
    private isConnecting = false;
    private isClosing = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private consumerCallback: ((msg: amqp.ConsumeMessage | null) => Promise<void>) | null = null;
    private prefetchCount = 10;
    private onError?: (err: any) => void;

    constructor(options: RabbitMQOptions) {
        this.host = options.host;
        this.queueName = options.queue;
        this.onError = options.onError;
    }

    public async connect(): Promise<amqp.Channel> {
        if (this.channel && this.connection) {
            return this.channel;
        }
        if (this.isConnecting) {
            let attempts = 0;
            while (this.isConnecting && attempts < 20) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                attempts++;
            }
            if (this.channel) return this.channel;
        }

        this.isConnecting = true;
        try {
            log('[amqp] Connecting to RabbitMQ host...');
            const conn = await amqp.connect(this.host);
            this.connection = conn;

            conn.on('error', (err) => {
                error('[amqp] Connection error:', err);
                if (this.onError) this.onError(err);
                this.handleDisconnect();
            });

            conn.on('close', () => {
                warn('[amqp] Connection closed.');
                this.handleDisconnect();
            });

            const ch = await conn.createChannel();
            this.channel = ch;

            ch.on('error', (err) => {
                error('[amqp] Channel error:', err);
                if (this.onError) this.onError(err);
                this.channel = null;
            });

            ch.on('close', () => {
                warn('[amqp] Channel closed.');
                this.channel = null;
            });

            await this.assertTopology(ch);
            this.isConnecting = false;
            log('[amqp] RabbitMQ connected and topology asserted.');
            return ch;
        } catch (err) {
            this.isConnecting = false;
            this.handleDisconnect();
            throw err;
        }
    }

    private async assertTopology(ch: amqp.Channel) {
        await ch.assertExchange(this.queueName, 'direct', { durable: true });
        await ch.assertExchange(this.queueName + '-dead', 'direct', { durable: true });

        await ch.assertQueue(this.queueName, { durable: true, deadLetterExchange: this.queueName + '-dead' });
        await ch.assertQueue(this.queueName + '-dead', { durable: true, deadLetterExchange: this.queueName, messageTtl: 2000 });

        await ch.bindExchange(this.queueName, this.queueName, '');
        await ch.bindExchange(this.queueName + '-dead', this.queueName + '-dead', '');
    }

    private handleDisconnect() {
        this.connection = null;
        this.channel = null;

        if (!this.isClosing) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.isClosing || this.connection) return;
            log('[amqp] Attempting to reconnect to RabbitMQ...');
            try {
                await this.connect();
                if (this.consumerCallback && this.channel) {
                    await this.startConsuming();
                }
            } catch (e) {
                error('[amqp] Reconnection attempt failed:', e);
            }
        }, 3000);
    }

    public async sendToQueue(content: Buffer, options?: amqp.Options.Publish): Promise<boolean> {
        let ch = this.channel;
        if (!ch || !this.connection) {
            ch = await this.connect();
        }
        if (!ch) {
            throw new Error('RabbitMQ channel unavailable');
        }

        const success = ch.sendToQueue(this.queueName, content, options);
        if (!success) {
            throw new Error('RabbitMQ write buffer full / sendToQueue returned false');
        }
        return success;
    }

    public async consume(
        onMessage: (msg: amqp.ConsumeMessage | null) => Promise<void>,
        options?: { prefetch?: number }
    ) {
        this.consumerCallback = onMessage;
        if (options?.prefetch) {
            this.prefetchCount = options.prefetch;
        }

        if (!this.channel) {
            await this.connect();
        }

        await this.startConsuming();
    }

    private async startConsuming() {
        if (!this.channel || !this.consumerCallback) return;
        await this.channel.prefetch(this.prefetchCount);
        await this.channel.consume(
            this.queueName,
            async (msg) => {
                if (this.consumerCallback) {
                    await this.consumerCallback(msg);
                }
            },
            { noAck: false }
        );
        log('[amqp] Consuming messages from queue:', this.queueName);
    }

    public ack(message: amqp.Message, allUpTo?: boolean): void {
        if (this.channel) {
            this.channel.ack(message, allUpTo);
        }
    }

    public reject(message: amqp.Message, requeue?: boolean): void {
        if (this.channel) {
            this.channel.reject(message, requeue);
        }
    }

    public async close() {
        this.isClosing = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            if (this.channel) {
                await this.channel.close().catch(() => {});
            }
            if (this.connection) {
                await this.connection.close().catch(() => {});
            }
        } finally {
            this.channel = null;
            this.connection = null;
        }
    }

    public getChannel(): amqp.Channel | null {
        return this.channel;
    }

    public isConnected(): boolean {
        return this.channel !== null && this.connection !== null;
    }
}

export async function setup(host: string, queue: string) {
    const connection = await amqp.connect(host);
    const channel = await connection.createChannel();

    // setup dead letter exchange for requeues
    await channel.assertExchange(queue, 'direct', { durable: true });
    await channel.assertExchange(queue + '-dead', 'direct', { durable: true });

    await channel.assertQueue(queue, { durable: true, deadLetterExchange: queue + '-dead' });
    await channel.assertQueue(queue + '-dead', { durable: true, deadLetterExchange: queue, messageTtl: 2000 });

    await channel.bindExchange(queue, queue, '');
    await channel.bindExchange(queue + '-dead', queue + '-dead', '');

    return channel;
}
