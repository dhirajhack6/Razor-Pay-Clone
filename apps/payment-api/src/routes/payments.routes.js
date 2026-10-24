import { HttpServer } from '../server.js';
import { toPaise, toRupeesString, resolveRuntimeUrls, PaymentStatus, safeEqual } from '@youpi/common';
import { isTerminalStatus, toPublicOutcome } from '@youpi/core';
import { isPaymentOwner } from '../auth-guard.js';

/**
 * Registers merchant-facing payment routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   checkoutBaseUrl: string
 * }} ctx
 */
export function registerPaymentRoutes(server, ctx) {
  function resolveCheckoutBaseUrl(merchant) {
    if (merchant?.branding) {
      try {
        const urls = resolveRuntimeUrls(merchant.branding);
        if (urls && urls.checkoutUrl) return urls.checkoutUrl;
      } catch {}
    }
    return ctx.checkoutBaseUrl || 'http://localhost:7000';
  }

  // POST /api/v1/payments
  server.post('/api/v1/payments', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;

    // Resolve merchant (default to first/demo merchant if none passed in header)
    const merchantId = req.headers['x-merchant-id'] || body.merchantId;
    let merchant;
    if (merchantId) {
      merchant = ctx.merchantRepo.findById(merchantId);
    } else {
      merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    }

    if (!merchant) {
      HttpServer.json(res, 400, { error: 'Merchant not found or not configured.' });
      return;
    }

    if (req.headers['x-merchant-key']) {
      if (!merchant.webhookSecret || !safeEqual(req.headers['x-merchant-key'].trim(), merchant.webhookSecret)) {
        HttpServer.json(res, 401, { error: 'Invalid merchant key', code: 'INVALID_MERCHANT_KEY' });
        return;
      }
    }

    if (!body.orderId || !body.amount) {
      HttpServer.json(res, 400, { error: 'Missing required fields: orderId and amount.' });
      return;
    }

    const deviceId = body.deviceId || req.headers['x-device-id'] || null;
    if (deviceId && ctx.deviceRepo) {
      let dev = ctx.deviceRepo.findById(deviceId);
      if (!dev) {
        try {
          ctx.deviceRepo.create({
            id: deviceId,
            publicKey: `adhoc_${deviceId}`,
            fingerprintHash: `fp_${deviceId}`
          });
        } catch {}
      }
    }

    // Check idempotency & active session state
    const existing = ctx.sessionRepo.findByOrderId(merchant.id, body.orderId);
    if (existing) {
      // If SUCCESS: order is already paid, return existing completed session
      if (existing.status === PaymentStatus.SUCCESS) {
        HttpServer.json(res, 200, {
          paymentId: existing.id,
          orderId: existing.orderId,
          amount: toRupeesString(existing.amountPaise),
          amountPaise: existing.amountPaise.toString(),
          currency: existing.currency,
          status: existing.status,
          checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${existing.id}`
        });
        return;
      }

      // Check if existing session is stale
      const now = Date.now();
      const isStale = (existing.status === PaymentStatus.ACTIVE && existing.expiresAt && existing.expiresAt.getTime() <= now) ||
        (existing.status === PaymentStatus.PROCESSING && existing.processingExpiresAt && existing.processingExpiresAt.getTime() <= now);
      if (isStale) {
        const terminalStatus = existing.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
        ctx.sessionRepo.transitionToTerminal(existing.id, terminalStatus);
        if (existing.receivingAccountId) {
          ctx.queueEngine.promoteNext(existing.receivingAccountId);
        }
        existing.status = terminalStatus;
        if (ctx.eventEmitter) {
          ctx.eventEmitter.emit(`PAYMENT.${terminalStatus}`, {
            paymentId: existing.id,
            orderId: existing.orderId,
            merchantId: existing.merchantId,
            amountPaise: existing.amountPaise
          });
        }
      }

      // If existing is non-terminal (ACTIVE, PROCESSING, QUEUED, INITIATED):
      if ([PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED].includes(existing.status)) {
        // CASE 3: Active session + Different device -> DUPLICATE_SESSION_DETECTED
        if (deviceId && existing.deviceId && deviceId !== existing.deviceId) {
          HttpServer.json(res, 409, {
            error: 'DUPLICATE_SESSION_DETECTED',
            code: 'DEVICE_SESSION_MISMATCH',
            session_id: existing.id,
            activeSession: {
              paymentId: existing.id,
              orderId: existing.orderId,
              amount: toRupeesString(existing.amountPaise)
            },
            action: 'END_SESSION_AND_CREATE_NEW',
            message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.'
          });
          return;
        }

        // CASE 2: Active session + Same device -> CONTINUE ACTIVE SESSION
        HttpServer.json(res, 200, {
          paymentId: existing.id,
          orderId: existing.orderId,
          amount: toRupeesString(existing.amountPaise),
          amountPaise: existing.amountPaise.toString(),
          currency: existing.currency,
          status: existing.status,
          activeSessionDetected: true,
          checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${existing.id}`
        });
        return;
      }

      // CASE 4: Previous session is TERMINAL (FAILED, EXPIRED, CANCELLED) -> RETRY / NEW ATTEMPT!
      // Invariant: Keep merchant's exact orderId untouched so webhooks, reconciliations, and reporting align.
      body.orderId = body.orderId.replace(/-R\d+$/, '');
    }

    let amountPaise;
    try {
      amountPaise = toPaise(body.amount);
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }

    const isCounterPayment = body.method === 'CASH_COUNTER' || body.method === 'CARD_COUNTER';

    let receivingAccountId = null;
    let receivingAccountSnapshot = null;
    if (!isCounterPayment) {
      // Resolve active receiving account for UPI
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(merchant.id);
      if (!receivingAccount) {
        HttpServer.json(res, 500, { error: 'No active UPI receiving account configured for merchant.' });
        return;
      }
      receivingAccountId = receivingAccount.id;
      receivingAccountSnapshot = {
        id: receivingAccount.id,
        upiId: receivingAccount.upiId,
        payeeName: receivingAccount.payeeName,
        isMerchantEnabled: receivingAccount.isMerchantEnabled
      };
    }

    // Resolve customer if provided (optional pre-existing customer)
    let customerId = body.customerId || null;
    if (!customerId && (body.customer?.mobileNumber || body.customer?.phoneNumber || body.customer?.email) && ctx.customerRepo) {
      const ident = body.customer.email || body.customer.mobileNumber || body.customer.phoneNumber;
      const existingCust = ctx.customerRepo.findByIdentifier(ident);
      if (existingCust) {
        customerId = existingCust.id;
      }
    }

    // Server-side Ban Enforcement (Section 3)
    if (customerId && ctx.customerRepo && ctx.customerRepo.isBanned(customerId)) {
      HttpServer.json(res, 403, {
        status: 'BLOCKED',
        error: 'ACCESS BLOCKED: Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    // Check if customer already has an active payment session on another device (CASE 3)
    if (customerId && ctx.sessionRepo) {
      const activeForCust = ctx.sessionRepo.findActiveForCustomer ? ctx.sessionRepo.findActiveForCustomer(customerId) : null;
      if (activeForCust) {
        if (deviceId && activeForCust.deviceId && deviceId !== activeForCust.deviceId) {
          HttpServer.json(res, 409, {
            error: 'DUPLICATE_SESSION_DETECTED',
            code: 'DEVICE_SESSION_MISMATCH',
            session_id: activeForCust.id,
            activeSession: {
              paymentId: activeForCust.id,
              orderId: activeForCust.orderId,
              amount: toRupeesString(activeForCust.amountPaise)
            },
            action: 'END_SESSION_AND_CREATE_NEW',
            message: 'This customer already has an active payment session on another device. For security reasons, this session cannot be continued from this device.'
          });
          return;
        }
      }
    }

    // Invariant: Do NOT start payment session timer until customer is authenticated/logged in!
    // Customer sign in or sign up in the checkout portal is mandatory before slot activation or timer start.
    // Digital UPI payments MUST ALWAYS start in status INITIATED without acquiring a concurrency slot or timer.
    // Only physical counter payments (CASH_COUNTER, CARD_COUNTER) start as ACTIVE (they do not use UPI slots).
    // The only exception for UPI auto-activation is explicit developer test suite flag: body.autoActivate === true.
    const isExplicitTestAutoActivate = body.autoActivate === true || body.autoActivate === 'true';
    const shouldActivateNow = isCounterPayment || isExplicitTestAutoActivate;
    const initialStatus = isCounterPayment ? PaymentStatus.ACTIVE : PaymentStatus.INITIATED;

    const sessionMetadata = {
      ...(body.metadata || {}),
      ...(receivingAccountSnapshot ? { receivingAccountSnapshot } : {})
    };

    if (deviceId && customerId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(deviceId, customerId); } catch {}
    }

    // Create session in DB
    const session = ctx.sessionRepo.create({
      merchantId: merchant.id,
      customerId,
      receivingAccountId,
      orderId: body.orderId,
      amountPaise,
      currency: body.currency || 'INR',
      method: body.method || 'UPI',
      status: initialStatus,
      returnUrl: body.returnUrl || null,
      idempotencyKey: idempotencyKey || null,
      deviceId,
      metadata: sessionMetadata
    });

    // Enqueue or Activate slot via QueueEngine ONLY when counter payment or explicitly requested by automated test runner
    let queueResult = { status: initialStatus, queuePosition: 0, expiresAt: null };
    if (!isCounterPayment && receivingAccountId && shouldActivateNow) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

      // If activated immediately, start Timer 1 (5 minutes)
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
    }

    HttpServer.json(res, 201, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(amountPaise),
      amountPaise: amountPaise.toString(),
      currency: session.currency,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${session.id}`
    });
  });

  // GET /api/v1/payments/:id
  server.get('/api/v1/payments/:id', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const publicStatus = isTerminalStatus(session.status)
      ? toPublicOutcome(session.status)
      : session.status;

    // Fields any payment-id holder may read. Everything else is merchant-private: the raw
    // state machine status, verification internals, merchant metadata and the return URL.
    const publicView = {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: publicStatus,
      method: session.method,
      completedAt: session.completedAt ? session.completedAt.toISOString() : null
    };

    if (!isPaymentOwner(req, session, ctx)) {
      HttpServer.json(res, 200, publicView);
      return;
    }

    HttpServer.json(res, 200, {
      ...publicView,
      internalStatus: session.status,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      returnUrl: session.returnUrl,
      metadata: session.metadata
    });
  });

  // GET /api/v1/payments/:id/cod (Developer COD Info Endpoint)
  server.get('/api/v1/payments/:id/cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    // Order ids are merchant-chosen and often sequential, so the delivery contact and metadata
    // are only for the owning merchant (or the gateway); anyone else gets the order status.
    const owner = isPaymentOwner(req, session, ctx);
    let customer = null;
    if (owner && session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        const isOwner = isPaymentOwner(req, session, ctx);
        customer = {
          id: c.id,
          name: c.name,
          email: isOwner ? c.email : (c.email ? `${c.email.slice(0, 2)}***@${c.email.split('@')[1] || '***'}` : null),
          mobileNumber: isOwner ? c.mobileNumber : (c.mobileNumber ? `${c.mobileNumber.slice(0, 2)}******${c.mobileNumber.slice(-2)}` : null)
        };
      }
    }

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      isCod: session.method === 'COD',
      customer: owner ? customer : null,
      placedAt: session.completedAt ? (session.completedAt.toISOString ? session.completedAt.toISOString() : session.completedAt) : (session.createdAt?.toISOString ? session.createdAt.toISOString() : session.createdAt),
      ...(owner ? { metadata: session.metadata } : {})
    });
  });

  // GET /api/v1/orders/:orderId/cod (Developer COD Info by Merchant Order ID)
  server.get('/api/v1/orders/:orderId/cod', async (req, res, params) => {
    const merchantId = req.headers['x-merchant-id'] || req.query.merchantId;
    let merchant;
    if (merchantId) {
      merchant = ctx.merchantRepo.findById(merchantId);
    } else {
      merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    }

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found.' });
      return;
    }

    const session = ctx.sessionRepo.findByOrderId(merchant.id, params.orderId);
    if (!session) {
      HttpServer.json(res, 404, { error: `Order not found: ${params.orderId}` });
      return;
    }

    // Order ids are merchant-chosen and often sequential, so the delivery contact and metadata
    // are only for the owning merchant (or the gateway); anyone else gets the order status.
    const owner = isPaymentOwner(req, session, ctx);
    let customer = null;
    if (owner && session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        const isOwner = isPaymentOwner(req, session, ctx);
        customer = {
          id: c.id,
          name: c.name,
          email: isOwner ? c.email : (c.email ? `${c.email.slice(0, 2)}***@${c.email.split('@')[1] || '***'}` : null),
          mobileNumber: isOwner ? c.mobileNumber : (c.mobileNumber ? `${c.mobileNumber.slice(0, 2)}******${c.mobileNumber.slice(-2)}` : null)
        };
      }
    }

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      isCod: session.method === 'COD',
      customer: owner ? customer : null,
      placedAt: session.completedAt ? (session.completedAt.toISOString ? session.completedAt.toISOString() : session.completedAt) : (session.createdAt?.toISOString ? session.createdAt.toISOString() : session.createdAt),
      ...(owner ? { metadata: session.metadata } : {})
    });
  });

  // ==========================================
  // RAZORPAY-COMPATIBLE PUBLIC REST API SUITE
  // ==========================================

  // Helper to resolve merchant from Basic Auth (key_id:key_secret) or headers
  function resolveRazorpayMerchant(req) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const [keyId] = decoded.split(':');
        if (keyId) {
          const m = ctx.merchantRepo.findById(keyId);
          if (m) return m;
        }
      } catch {}
    }
    const merchantId = req.headers['x-merchant-id'] || req.headers['x-razorpay-account'];
    if (merchantId) {
      const m = ctx.merchantRepo.findById(merchantId);
      if (m) return m;
    }
    return ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
  }

  // Handler for Razorpay Order Creation: POST /v1/orders and POST /api/v1/orders
  async function handleCreateRazorpayOrder(req, res) {
    const body = await HttpServer.parseBody(req);
    const merchant = resolveRazorpayMerchant(req);
    if (!merchant) {
      HttpServer.json(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Merchant account not found.' } });
      return;
    }

    if (!body.amount) {
      HttpServer.json(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount is required in paise.' } });
      return;
    }

    const amountPaise = typeof body.amount === 'number' || typeof body.amount === 'string'
      ? BigInt(Math.round(Number(body.amount)))
      : BigInt(body.amount);

    const randomSuffix = Math.random().toString(36).substring(2, 10);
    const orderId = body.receipt || `order_${randomSuffix}`;
    const receivingAccount = ctx.accountRepo.findActiveForMerchant(merchant.id) || ctx.accountRepo.findAll()[0];

    const session = ctx.sessionRepo.create({
      merchantId: merchant.id,
      receivingAccountId: null,
      orderId,
      amountPaise,
      currency: body.currency || 'INR',
      status: PaymentStatus.ACTIVE,
      metadata: body.notes || {}
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    HttpServer.json(res, 201, {
      id: session.id,
      entity: 'order',
      amount: Number(amountPaise),
      amount_paid: 0,
      amount_due: Number(amountPaise),
      currency: session.currency,
      receipt: body.receipt || orderId,
      offer_id: null,
      status: 'created',
      attempts: 0,
      notes: body.notes || {},
      created_at: nowSeconds,
      checkout_url: `${resolveCheckoutBaseUrl(merchant)}/checkout/${session.id}`
    });
  }

  server.post('/v1/orders', handleCreateRazorpayOrder);
  server.post('/api/v1/orders', handleCreateRazorpayOrder);

  // Handler for Razorpay Order Status: GET /v1/orders/:id and GET /api/v1/orders/:id
  async function handleGetRazorpayOrder(req, res, params) {
    const session = ctx.sessionRepo.findById(params.id) || ctx.sessionRepo.findByOrderId('00000000-0000-0000-0000-000000000001', params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: { code: 'BAD_REQUEST_ERROR', description: `Order not found: ${params.id}` } });
      return;
    }
    const isPaid = session.status === PaymentStatus.SUCCESS;
    const amountNum = Number(session.amountPaise);
    HttpServer.json(res, 200, {
      id: session.id,
      entity: 'order',
      amount: amountNum,
      amount_paid: isPaid ? amountNum : 0,
      amount_due: isPaid ? 0 : amountNum,
      currency: session.currency,
      receipt: session.orderId,
      status: isPaid ? 'paid' : (session.status === PaymentStatus.ACTIVE ? 'attempted' : 'created'),
      attempts: isPaid ? 1 : 0,
      notes: session.metadata || {},
      created_at: Math.floor(new Date(session.createdAt).getTime() / 1000)
    });
  }

  server.get('/v1/orders/:id', handleGetRazorpayOrder);
  server.get('/api/v1/orders/:id', handleGetRazorpayOrder);

  // Handler for Razorpay Payment Query: GET /v1/payments/:id
  async function handleGetRazorpayPayment(req, res, params) {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: { code: 'BAD_REQUEST_ERROR', description: `Payment not found: ${params.id}` } });
      return;
    }
    const isSuccess = session.status === PaymentStatus.SUCCESS;
    const amountNum = Number(session.amountPaise);
    const methodStr = (session.method || 'upi').toLowerCase();
    HttpServer.json(res, 200, {
      id: `pay_${session.id.replace(/-/g, '').slice(0, 14)}`,
      entity: 'payment',
      amount: amountNum,
      currency: session.currency,
      status: isSuccess ? 'captured' : 'failed',
      order_id: session.id,
      invoice_id: null,
      international: false,
      method: methodStr === 'card_counter' ? 'card' : (methodStr === 'cash_counter' ? 'cash' : methodStr),
      amount_refunded: 0,
      refund_status: null,
      captured: isSuccess,
      description: `Payment for order ${session.orderId}`,
      card_id: null,
      bank: null,
      wallet: null,
      vpa: session.metadata?.vpa || null,
      email: session.metadata?.email || 'customer@example.com',
      contact: session.metadata?.contact || '+919999999999',
      fee: 0,
      tax: 0,
      error_code: null,
      error_description: null,
      created_at: Math.floor(new Date(session.createdAt).getTime() / 1000)
    });
  }

  server.get('/v1/payments/:id', handleGetRazorpayPayment);
  server.get('/api/v1/payments/:id', handleGetRazorpayPayment);

  // Handler for Razorpay Capture: POST /v1/payments/:id/capture
  async function handleCaptureRazorpayPayment(req, res, params) {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: { code: 'BAD_REQUEST_ERROR', description: `Payment not found: ${params.id}` } });
      return;
    }
    return handleGetRazorpayPayment(req, res, params);
  }

  server.post('/v1/payments/:id/capture', handleCaptureRazorpayPayment);
  server.post('/api/v1/payments/:id/capture', handleCaptureRazorpayPayment);
}
