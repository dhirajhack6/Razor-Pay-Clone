import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, MerchantRepository } from '@youpi/db';
import { startServer } from '../index.js';
import { PaymentStatus } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Razorpay API & Checkout Compatibility Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startServer(6198, testDb);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqOpts = {
        method: options.method || 'GET',
        headers: authHeadersFor(path, options.headers || {})
      };

      const req = http.request(url, reqOpts, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });

      req.on('error', reject);

      if (options.body) {
        const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        req.setHeader('Content-Type', 'application/json');
        req.write(payload);
      }

      req.end();
    });
  }

  test('POST /v1/orders creates Razorpay-compatible order entity with 201 Created', async () => {
    const res = await request('/v1/orders', {
      method: 'POST',
      body: {
        amount: 49900, // 499.00 in paise
        currency: 'INR',
        receipt: 'ORDER_TEST_001',
        notes: { customer_name: 'Test Buyer' }
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.entity, 'order');
    assert.equal(res.body.amount, 49900);
    assert.equal(res.body.currency, 'INR');
    assert.equal(res.body.status, 'created');
    assert.ok(res.body.id);
    assert.ok(res.body.checkout_url);
  });

  test('GET /v1/orders/:id returns order details with status', async () => {
    const createRes = await request('/v1/orders', {
      method: 'POST',
      body: { amount: 19900, currency: 'INR', receipt: 'ORD_QUERY_1' }
    });
    const orderId = createRes.body.id;

    const getRes = await request(`/v1/orders/${orderId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.id, orderId);
    assert.equal(getRes.body.amount, 19900);
    assert.equal(getRes.body.currency, 'INR');
    assert.equal(getRes.body.receipt, 'ORD_QUERY_1');
  });

  test('POST /api/v1/checkout/:id/pay-online with CARD succeeds with razorpay_payment_id', async () => {
    const createRes = await request('/v1/orders', {
      method: 'POST',
      body: { amount: 99900, currency: 'INR', receipt: 'CARD_PAY_001' }
    });
    const sessionId = createRes.body.id;

    const payRes = await request(`/api/v1/checkout/${sessionId}/pay-online`, {
      method: 'POST',
      body: {
        method: 'CARD',
        card: { number: '4111222233334444', expiry: '12/28', cvv: '123', name: 'Card Holder' },
        otp: '123456'
      }
    });

    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.success, true);
    assert.equal(payRes.body.status, 'SUCCESS');
    assert.equal(payRes.body.method, 'CARD');
    assert.ok(payRes.body.razorpay_payment_id.startsWith('pay_'));

    // Check payment query GET /v1/payments/:id
    const paymentQuery = await request(`/v1/payments/${sessionId}`);
    assert.equal(paymentQuery.status, 200);
    assert.equal(paymentQuery.body.status, 'captured');
    assert.equal(paymentQuery.body.captured, true);
    assert.equal(paymentQuery.body.method, 'card');
  });

  test('POST /api/v1/checkout/:id/pay-online with NETBANKING succeeds', async () => {
    const createRes = await request('/v1/orders', {
      method: 'POST',
      body: { amount: 50000, currency: 'INR', receipt: 'NB_PAY_001' }
    });
    const sessionId = createRes.body.id;

    const payRes = await request(`/api/v1/checkout/${sessionId}/pay-online`, {
      method: 'POST',
      body: {
        method: 'NETBANKING',
        bank: 'HDFC',
        otp: '123456'
      }
    });

    assert.equal(payRes.status, 200);
    assert.equal(payRes.body.success, true);
    assert.equal(payRes.body.status, 'SUCCESS');
    assert.equal(payRes.body.method, 'NETBANKING');
  });

  test('POST /api/v1/checkout/:id/verify-utr with direct UTR succeeds instantly', async () => {
    const createRes = await request('/v1/orders', {
      method: 'POST',
      body: { amount: 15000, currency: 'INR', receipt: 'UTR_PAY_001' }
    });
    const sessionId = createRes.body.id;

    const utrRes = await request(`/api/v1/checkout/${sessionId}/verify-utr`, {
      method: 'POST',
      body: {
        utr: '429718294821'
      }
    });

    assert.equal(utrRes.status, 200);
    assert.equal(utrRes.body.success, true);
    assert.equal(utrRes.body.status, 'SUCCESS');
    assert.equal(utrRes.body.method, 'UPI');
    assert.equal(utrRes.body.utr, '429718294821');
  });

  test('Multiple online orders can be checked out concurrently without queue blocking', async () => {
    // Create 3 orders simultaneously
    const [ord1, ord2, ord3] = await Promise.all([
      request('/v1/orders', { method: 'POST', body: { amount: 10000, currency: 'INR', receipt: 'CONC_1' } }),
      request('/v1/orders', { method: 'POST', body: { amount: 20000, currency: 'INR', receipt: 'CONC_2' } }),
      request('/v1/orders', { method: 'POST', body: { amount: 30000, currency: 'INR', receipt: 'CONC_3' } })
    ]);

    // Switch and pay all 3 concurrently using cards
    const [p1, p2, p3] = await Promise.all([
      request(`/api/v1/checkout/${ord1.body.id}/pay-online`, { method: 'POST', body: { method: 'CARD' } }),
      request(`/api/v1/checkout/${ord2.body.id}/pay-online`, { method: 'POST', body: { method: 'CARD' } }),
      request(`/api/v1/checkout/${ord3.body.id}/pay-online`, { method: 'POST', body: { method: 'NETBANKING', bank: 'ICICI' } })
    ]);

    assert.equal(p1.body.status, 'SUCCESS');
    assert.equal(p2.body.status, 'SUCCESS');
    assert.equal(p3.body.status, 'SUCCESS');
  });
});
