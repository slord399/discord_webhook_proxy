import assert from 'node:assert';
import axios from 'axios';
import {
    getErrorType,
    handleUnhandledError,
    resetAlertState,
    getAlertState
} from './errorAlert';

async function runTests() {
    console.log('Running errorAlert tests...');

    // Test 1: getErrorType
    assert.strictEqual(getErrorType('Simple string error'), 'Simple string error');
    assert.strictEqual(
        getErrorType(new TypeError('Cannot read property x')),
        'TypeError: Cannot read property x'
    );
    assert.strictEqual(
        getErrorType({ name: 'CustomError', message: 'Something failed' }),
        'CustomError: Something failed'
    );
    assert.strictEqual(getErrorType(null), 'UnknownError');
    console.log('✓ getErrorType tests passed');

    // Test 2: Disabled config
    resetAlertState();
    let sentCount = 0;
    const originalPost = axios.post;
    // @ts-ignore
    axios.post = async () => {
        sentCount++;
        return { status: 200 };
    };

    try {
        for (let i = 0; i < 10; i++) {
            const result = await handleUnhandledError(
                new Error('Database error'),
                { enabled: false, webhook_url: 'http://localhost/webhook' }
            );
            assert.strictEqual(result, false);
        }
        assert.strictEqual(sentCount, 0, 'No webhook should be sent when disabled');
        console.log('✓ Disabled config tests passed');

        // Test 3: Throttling & Deduplication (> 3 consecutive occurrences threshold)
        resetAlertState();
        sentCount = 0;

        const config = { enabled: true, webhook_url: 'http://localhost/webhook' };

        // Occurrences 1 to 3: should return false, sentCount 0
        for (let i = 1; i <= 3; i++) {
            const res = await handleUnhandledError(new Error('Persistent error'), config);
            assert.strictEqual(res, false, `Occurrence ${i} should not trigger webhook`);
            assert.strictEqual(sentCount, 0, `Occurrence ${i} sentCount should be 0`);
        }

        // Occurrence 4: should return true, sentCount 1
        const res4 = await handleUnhandledError(new Error('Persistent error'), config);
        assert.strictEqual(res4, true, 'Occurrence 4 should trigger webhook');
        assert.strictEqual(sentCount, 1, 'Occurrence 4 sentCount should be 1');

        // Occurrences 5 to 10 (immediate subsequent): should return false, sentCount remains 1 (throttled for 1 hour)
        for (let i = 5; i <= 10; i++) {
            const res = await handleUnhandledError(new Error('Persistent error'), config);
            assert.strictEqual(res, false, `Occurrence ${i} should be throttled`);
            assert.strictEqual(sentCount, 1, `Occurrence ${i} sentCount should remain 1`);
        }
        console.log('✓ Consecutive threshold (> 3) and 1-hour throttle tests passed');

        // Test 4: Reset on different error
        resetAlertState();
        sentCount = 0;

        // 3 times Error A
        for (let i = 1; i <= 3; i++) {
            await handleUnhandledError(new Error('Error A'), config);
        }
        assert.strictEqual(sentCount, 0);

        // 1 time Error B -> resets count
        await handleUnhandledError(new Error('Error B'), config);
        assert.strictEqual(getAlertState().consecutiveCount, 1);
        assert.strictEqual(sentCount, 0);

        // 3 times Error A -> count for Error A is now 3 (not 4)
        for (let i = 1; i <= 3; i++) {
            await handleUnhandledError(new Error('Error A'), config);
        }
        assert.strictEqual(sentCount, 0);

        // 4th consecutive time Error A -> triggers alert
        const resA4 = await handleUnhandledError(new Error('Error A'), config);
        assert.strictEqual(resA4, true);
        assert.strictEqual(sentCount, 1);
        console.log('✓ Reset on error type change tests passed');

        // Test 5: Immediate alert flag & notification failure safeguard
        resetAlertState();
        sentCount = 0;

        // Immediate flag should trigger alert on 1st occurrence
        const resImmediate = await handleUnhandledError(
            new Error('Critical Connection Refused'),
            config,
            { immediate: true }
        );
        assert.strictEqual(resImmediate, true, 'Immediate option should bypass consecutive threshold');
        assert.strictEqual(sentCount, 1);

        // Notification dispatch failure safeguard (e.g. network timeout when sending webhook)
        // @ts-ignore
        axios.post = async () => {
            throw new Error('Network timeout sending webhook notification');
        };

        resetAlertState();
        const resFailure = await handleUnhandledError(
            new Error('Another Connection Issue'),
            config,
            { immediate: true }
        );
        assert.strictEqual(resFailure, false, 'Failed webhook dispatch should safely return false without throwing');
        console.log('✓ Immediate alert and notification failure safeguard tests passed');

    } finally {
        axios.post = originalPost;
    }

    console.log('All errorAlert tests passed successfully!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
