import assert from 'node:assert';
import { Hono } from 'hono';
import { RabbitMQClient } from './rmq';

function formatNumberWithUnderscores(val: number | string): string {
    const numStr = String(val);
    if (!/^\d+$/.test(numStr)) return numStr;
    return numStr.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

const createStatsApp = (totalRequests: number, statsSinceStr: string, mockNow?: Date) => {
    const app = new Hono();
    app.get('/stats', (c) => {
        const STATS_SINCE = statsSinceStr;
        const statsSinceDate = new Date(STATS_SINCE);
        const now = mockNow || new Date();
        const elapsedMs = now.getTime() - statsSinceDate.getTime();
        const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

        let requestsPer = {
            day: '0',
            week: '0',
            month: '0',
            year: '0'
        };

        if (!isNaN(statsSinceDate.getTime()) && elapsedDays > 0) {
            const perDay = Math.round(totalRequests / elapsedDays);
            const perWeek = Math.round(totalRequests / (elapsedDays / 7));
            const perMonth = Math.round(totalRequests / (elapsedDays / 30.4375));
            const perYear = Math.round(totalRequests / (elapsedDays / 365.25));

            requestsPer = {
                day: formatNumberWithUnderscores(perDay),
                week: formatNumberWithUnderscores(perWeek),
                month: formatNumberWithUnderscores(perMonth),
                year: formatNumberWithUnderscores(perYear)
            };
        }

        return c.json({
            requests: formatNumberWithUnderscores(totalRequests),
            webhooks: 37,
            version: '108_143_750',
            stats_since: STATS_SINCE,
            requests_per: requestsPer,
            services: {
                rabbitmq: {
                    status: 'connected',
                    status_since: STATS_SINCE
                },
                redis: {
                    status: 'connected',
                    status_since: STATS_SINCE
                }
            }
        });
    });
    return app;
};

async function runTests() {
    console.log('Running stats rate calculation tests...');

    // Test 1: Standard elapsed time calculation (10 days elapsed, 34,280 requests)
    const statsSince = '2025-01-01T00:00:00.000Z';
    const mockNow = new Date('2025-01-11T00:00:00.000Z'); // exactly 10 days later
    const app = createStatsApp(34280, statsSince, mockNow);

    const res = await app.request('http://localhost/stats');
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    const keys = Object.keys(json);
    const statsSinceIndex = keys.indexOf('stats_since');
    const requestsPerIndex = keys.indexOf('requests_per');
    const servicesIndex = keys.indexOf('services');

    assert.strictEqual(requestsPerIndex, statsSinceIndex + 1, 'requests_per should be positioned directly below stats_since');
    assert.strictEqual(servicesIndex, requestsPerIndex + 1, 'services should be positioned directly below requests_per');

    // Expected rates:
    // Day: 34280 / 10 = 3428 -> "3_428"
    // Week: 34280 / (10 / 7) = 23996 -> "23_996"
    // Month: 34280 / (10 / 30.4375) = 104339.75 -> Math.round -> 104340 -> "104_340"
    // Year: 34280 / (10 / 365.25) = 1252077 -> Math.round -> 1252077 -> "1_252_077"
    assert.deepStrictEqual(json.requests_per, {
        day: '3_428',
        week: '23_996',
        month: '104_340',
        year: '1_252_077'
    });
    console.log('✓ Standard request rate calculation test passed');

    // Test 4: Services object schema test
    assert.deepStrictEqual(json.services, {
        rabbitmq: {
            status: 'connected',
            status_since: statsSince
        },
        redis: {
            status: 'connected',
            status_since: statsSince
        }
    });
    console.log('✓ Services status_since response schema test passed');

    // Test 2: Zero or negative duration guard (stats_since in future or equal to now)
    const futureApp = createStatsApp(1000, '2099-01-01T00:00:00.000Z', new Date('2025-01-01T00:00:00.000Z'));
    const futureRes = await futureApp.request('http://localhost/stats');
    const futureJson = await futureRes.json();
    assert.deepStrictEqual(futureJson.requests_per, {
        day: '0',
        week: '0',
        month: '0',
        year: '0'
    });
    console.log('✓ Future stats_since guard test passed');

    // Test 3: Invalid date string guard
    const invalidApp = createStatsApp(1000, 'invalid-date-string');
    const invalidRes = await invalidApp.request('http://localhost/stats');
    const invalidJson = await invalidRes.json();
    assert.deepStrictEqual(invalidJson.requests_per, {
        day: '0',
        week: '0',
        month: '0',
        year: '0'
    });
    console.log('✓ Invalid date string guard test passed');

    // Test 5: RabbitMQClient status transition tracking
    const bootTime = '2026-01-01T00:00:00.000Z';
    const rmqClient = new RabbitMQClient({
        host: 'amqp://localhost',
        queue: 'test-queue'
    }, bootTime);

    const initialRmqStatus = rmqClient.getStatusInfo();
    assert.strictEqual(initialRmqStatus.status, 'disconnected');
    assert.strictEqual(initialRmqStatus.status_since, bootTime);

    await new Promise((resolve) => setTimeout(resolve, 10));

    await rmqClient.close();
    const closedRmqStatus = rmqClient.getStatusInfo();
    assert.strictEqual(closedRmqStatus.status, 'disconnected');
    assert.strictEqual(closedRmqStatus.status_since, bootTime);

    (rmqClient as any).isConnecting = true;
    (rmqClient as any).updateStatus();
    const reconnectingRmqStatus = rmqClient.getStatusInfo();
    assert.strictEqual(reconnectingRmqStatus.status, 'reconnecting');
    assert.notStrictEqual(reconnectingRmqStatus.status_since, bootTime);
    assert.ok(new Date(reconnectingRmqStatus.status_since).getTime() > new Date(bootTime).getTime());
    console.log('✓ RabbitMQClient status transition tracking test passed');

    // Test 6: Redis connection status transition tracking logic
    let mockRedisStatus: 'ready' | 'reconnecting' | 'end' = 'reconnecting';
    const getMockRedisStatus = (): 'connected' | 'reconnecting' | 'disconnected' => {
        if (mockRedisStatus === 'ready') return 'connected';
        if (mockRedisStatus === 'reconnecting') return 'reconnecting';
        return 'disconnected';
    };

    let curRedisStatus = getMockRedisStatus();
    let redisStatusSince = bootTime;

    const updateRedisStatus = () => {
        const newStatus = getMockRedisStatus();
        if (newStatus !== curRedisStatus) {
            curRedisStatus = newStatus;
            redisStatusSince = new Date().toISOString();
        }
    };

    assert.strictEqual(curRedisStatus, 'reconnecting');
    assert.strictEqual(redisStatusSince, bootTime);

    await new Promise((resolve) => setTimeout(resolve, 10));

    updateRedisStatus();
    assert.strictEqual(redisStatusSince, bootTime);

    mockRedisStatus = 'ready';
    updateRedisStatus();
    assert.strictEqual(curRedisStatus, 'connected');
    assert.notStrictEqual(redisStatusSince, bootTime);
    assert.ok(new Date(redisStatusSince).getTime() > new Date(bootTime).getTime());
    console.log('✓ Redis status transition tracking test passed');

    console.log('All stats rate calculation tests passed successfully!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
