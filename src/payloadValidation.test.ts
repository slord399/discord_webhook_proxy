import assert from 'node:assert';
import { Hono } from 'hono';

// Unit tests for safe body parsing and validation logic in webhook routes

const app = new Hono();

// Simulate the POST and PATCH body validation handler logic from src/index.ts
const handleWebhookPost = async (c: any) => {
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

    return c.json({ success: true, body });
};

const handleWebhookQueue = async (c: any) => {
    let body: any;
    try {
        body = await c.req.json();
        if (!body || typeof body !== 'object') {
            body = {};
        }
    } catch {
        body = {};
    }

    return c.json({ success: true, body });
};

app.post('/api/webhooks/:id/:token', handleWebhookPost);
app.patch('/api/webhooks/:id/:token/messages/:messageId', handleWebhookPost);
app.post('/api/webhooks/:id/:token/queue', handleWebhookQueue);

async function runTests() {
    console.log('Running payload validation tests...');

    // Test 1: POST request with null JSON body
    const resNullPost = await app.request('http://localhost/api/webhooks/12345/abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null'
    });
    assert.strictEqual(resNullPost.status, 400);
    const dataNullPost = await resNullPost.json();
    assert.strictEqual(dataNullPost.error, 'No body provided. The proxy only accepts valid JSON bodies.');
    console.log('✓ POST null body test passed');

    // Test 2: POST request with empty body ("")
    const resEmptyPost = await app.request('http://localhost/api/webhooks/12345/abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ''
    });
    assert.strictEqual(resEmptyPost.status, 400);
    const dataEmptyPost = await resEmptyPost.json();
    assert.strictEqual(dataEmptyPost.error, 'No body provided. The proxy only accepts valid JSON bodies.');
    console.log('✓ POST empty string body test passed');

    // Test 3: POST request with JSON payload missing content/embeds/file (e.g., `{}`)
    const resMissingFieldsPost = await app.request('http://localhost/api/webhooks/12345/abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test' })
    });
    assert.strictEqual(resMissingFieldsPost.status, 400);
    const dataMissingFieldsPost = await resMissingFieldsPost.json();
    assert.strictEqual(dataMissingFieldsPost.error, 'No body provided. The proxy only accepts valid JSON bodies.');
    console.log('✓ POST missing required fields test passed');

    // Test 4: PATCH request with null JSON body
    const resNullPatch = await app.request('http://localhost/api/webhooks/12345/abc/messages/67890', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'null'
    });
    assert.strictEqual(resNullPatch.status, 400);
    const dataNullPatch = await resNullPatch.json();
    assert.strictEqual(dataNullPatch.error, 'No body provided. The proxy only accepts valid JSON bodies.');
    console.log('✓ PATCH null body test passed');

    // Test 5: Valid POST payload containing content
    const resValidPost = await app.request('http://localhost/api/webhooks/12345/abc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello World' })
    });
    assert.strictEqual(resValidPost.status, 200);
    const dataValidPost = await resValidPost.json();
    assert.strictEqual(dataValidPost.success, true);
    console.log('✓ Valid POST payload test passed');

    // Test 6: Queue endpoint with null body (should fallback to empty object {})
    const resQueueNull = await app.request('http://localhost/api/webhooks/12345/abc/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null'
    });
    assert.strictEqual(resQueueNull.status, 200);
    const dataQueueNull = await resQueueNull.json();
    assert.deepStrictEqual(dataQueueNull.body, {});
    console.log('✓ Queue null body fallback test passed');

    console.log('All payload validation tests passed successfully!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
