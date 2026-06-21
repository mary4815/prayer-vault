// Prayer Memory Vault — backend server (Stripe + WhatsApp + Email)
// Supabase handles auth + most data directly from the browser.
// This server only does what needs secret keys.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import twilio from 'twilio';

const {
  PORT = 8787, WEB_ORIGIN = '*',
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  DONATION_SUCCESS_URL, DONATION_CANCEL_URL,
  STRIPE_PRICE_PLUS, STRIPE_PRICE_CHURCH,
  BILLING_SUCCESS_URL, BILLING_CANCEL_URL, BILLING_RETURN_URL,
  RESEND_API_KEY, EMAIL_FROM,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
  ANTHROPIC_API_KEY,
  AI_MODEL_CHAT = 'claude-sonnet-4-6',
  AI_MODEL_FAST = 'claude-haiku-4-5-20251001',
  AI_DAILY_LIMIT = '40',
} = process.env;

const AI_LIMIT = Math.max(1, parseInt(AI_DAILY_LIMIT, 10) || 40);

// Subscription tiers. Map a plan name <-> its Stripe Price id (one direction
// for checkout, the reverse for resolving a plan from a webhook event).
const PLAN_TO_PRICE = { Plus: STRIPE_PRICE_PLUS, Church: STRIPE_PRICE_CHURCH };
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_TO_PRICE).filter(([, id]) => !!id).map(([plan, id]) => [id, plan])
);

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const admin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const tw = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const app = express();
app.use(cors({ origin: WEB_ORIGIN === '*' ? true : WEB_ORIGIN.split(',') }));

// Stripe webhook needs the RAW body — mount BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.mode === 'subscription') {
          // New subscription paid for — pull the full subscription and sync.
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          await syncSubscription(sub, s.metadata?.user_id || s.client_reference_id);
        } else {
          // One-off donation (mode: payment) — existing behaviour.
          const causeId = s.metadata?.cause_id;
          const userId = s.metadata?.user_id || null;
          const amount = (s.amount_total || 0) / 100;
          if (admin && causeId) {
            await admin.from('donations').insert({
              user_id: userId, cause_id: causeId, cause_name: s.metadata?.cause_name || '',
              amount, currency: s.currency || 'usd', stripe_session: s.id, status: 'paid',
            });
            await admin.rpc('increment_cause_raised', { p_cause: causeId, p_amount: amount });
          }
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(event.data.object);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('webhook handler error:', e.message);
    return res.status(500).send('handler error');
  }
  res.json({ received: true });
});

// Mirror a Stripe subscription into Supabase (subscriptions row + profiles.plan).
async function syncSubscription(sub, fallbackUserId) {
  if (!admin || !sub) return;
  const userId = sub.metadata?.user_id || fallbackUserId;
  if (!userId) { console.error('syncSubscription: no user_id on', sub.id); return; }
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = PRICE_TO_PLAN[priceId] || 'Personal';
  // 'deleted' events arrive with status 'canceled'; treat anything non-active as free.
  const status = sub.status || 'inactive';
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString() : null;
  const { error } = await admin.rpc('apply_subscription', {
    p_user: userId, p_plan: plan, p_status: status,
    p_customer: sub.customer || null, p_subscription: sub.id, p_period_end: periodEnd,
  });
  if (error) console.error('apply_subscription error:', error.message);
}

app.use(express.json());

// Verify the Supabase JWT sent by the browser (Authorization: Bearer <token>)
async function requireUser(req, res, next) {
  if (!admin) return res.status(500).json({ error: 'supabase not configured' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'unauthorized' });
  req.user = data.user;
  next();
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  stripe: !!stripe, supabase: !!admin, email: !!resend, whatsapp: !!tw,
  subscriptions: Object.keys(PRICE_TO_PLAN).length > 0,
  ai: !!ANTHROPIC_API_KEY,
}));

// ---------------------------------------------------------------------------
// AI Prayer Companion — Claude (Anthropic) proxied here so the key stays
// server-side. Memory + testimonies live in Supabase; the browser never sees
// the AI key and only talks to these JWT-protected routes.
// ---------------------------------------------------------------------------

// Single call to the Anthropic Messages API. Returns the plain text reply.
async function callClaude({ model, system, messages, maxTokens = 1024 }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ai not configured');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`anthropic ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  return (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// How many AI turns the user has spent today (resets at midnight UTC). Guards
// against runaway cost — the browser paywall can be bypassed, this can't.
async function aiUsageToday(userId) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from('ai_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('role', 'user').gte('created_at', since.toISOString());
  return count || 0;
}

const COMPANION_SYSTEM = [
  'You are the Prayer Companion inside Prayer Vault, a Christian prayer app.',
  'You are warm, gentle, and pastoral — never preachy or judgmental. Speak plainly,',
  'like a trusted friend who prays. Keep replies fairly short (2-5 short paragraphs).',
  "You are given the user's own prayer list as context; refer to their specific",
  'prayers and people by name when relevant, and notice patterns (recurring burdens,',
  'answered prayers). When you quote Scripture, give the reference (e.g. "Philippians 4:6-7")',
  'and quote it accurately. You are a companion, not a replacement for a pastor,',
  'doctor, or emergency help — gently say so if someone is in crisis.',
].join(' ');

// Build a compact text snapshot of the user's prayers for grounding the model.
async function prayerContext(userId) {
  const { data } = await admin.from('prayers')
    .select('person,request,category,answered,answered_note,created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(60);
  if (!data || !data.length) return 'The user has no saved prayers yet.';
  const fmt = p => {
    const who = p.person ? ` for ${p.person}` : '';
    const cat = p.category ? ` [${p.category}]` : '';
    const ans = p.answered ? ` (ANSWERED${p.answered_note ? ': ' + p.answered_note : ''})` : '';
    return `- ${p.request}${who}${cat}${ans}`;
  };
  return 'The user\'s prayers (most recent first):\n' + data.map(fmt).join('\n');
}

// Companion chat: remembers prior turns + the user's prayers.
app.post('/api/ai/chat', requireUser, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ai not configured' });
  const message = String((req.body || {}).message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty message' });
  if (message.length > 4000) return res.status(400).json({ error: 'message too long' });
  try {
    if (await aiUsageToday(req.user.id) >= AI_LIMIT) {
      return res.status(429).json({ error: `Daily limit reached (${AI_LIMIT} messages). Try again tomorrow.` });
    }
    const { data: history } = await admin.from('ai_messages')
      .select('role,content').eq('user_id', req.user.id)
      .order('created_at', { ascending: false }).limit(20);
    const prior = (history || []).reverse().map(m => ({ role: m.role, content: m.content }));
    const ctx = await prayerContext(req.user.id);
    const messages = [
      ...prior,
      { role: 'user', content: `(Context — my prayers)\n${ctx}\n\n---\n\n${message}` },
    ];
    const reply = await callClaude({ model: AI_MODEL_CHAT, system: COMPANION_SYSTEM, messages, maxTokens: 1024 });
    await admin.from('ai_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'assistant', content: reply },
    ]);
    res.json({ reply });
  } catch (e) {
    console.error('ai/chat error:', e.message);
    res.status(500).json({ error: 'The Companion is unavailable right now.' });
  }
});

// Suggest 1-3 Scripture verses for a topic or a specific prayer.
app.post('/api/ai/verse', requireUser, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ai not configured' });
  const { topic, prayerId } = req.body || {};
  try {
    let subject = String(topic || '').trim();
    if (!subject && prayerId) {
      const { data: p } = await admin.from('prayers')
        .select('request,person,category').eq('user_id', req.user.id).eq('id', prayerId).maybeSingle();
      if (p) subject = [p.request, p.person && `for ${p.person}`, p.category].filter(Boolean).join(' ');
    }
    if (!subject) return res.status(400).json({ error: 'nothing to look up' });
    const system = 'You are a Scripture guide. Return ONLY valid JSON, no prose, no markdown fences.';
    const prompt = `For someone praying about: "${subject}"\n` +
      'Return 1-3 encouraging, accurate Bible verses as JSON of the exact shape:\n' +
      '{"verses":[{"ref":"Book 0:0","text":"full verse text","why":"one short sentence on why it fits"}]}';
    const raw = await callClaude({
      model: AI_MODEL_FAST, system,
      messages: [{ role: 'user', content: prompt }], maxTokens: 700,
    });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { verses: [] }; }
    res.json({ verses: Array.isArray(parsed.verses) ? parsed.verses.slice(0, 3) : [] });
  } catch (e) {
    console.error('ai/verse error:', e.message);
    res.status(500).json({ error: 'Could not fetch a verse right now.' });
  }
});

// Write a shareable testimony from an answered prayer.
app.post('/api/ai/testimony', requireUser, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ai not configured' });
  const { prayerId } = req.body || {};
  if (!prayerId) return res.status(400).json({ error: 'prayerId required' });
  try {
    const { data: p } = await admin.from('prayers')
      .select('request,person,category,answered,answered_note,created_at,answered_date')
      .eq('user_id', req.user.id).eq('id', prayerId).maybeSingle();
    if (!p) return res.status(404).json({ error: 'prayer not found' });
    const system = 'You write short, heartfelt Christian testimonies. Return ONLY valid JSON, no markdown fences.';
    const detail = [
      `Prayer request: ${p.request}`,
      p.person && `Prayed for: ${p.person}`,
      p.category && `Category: ${p.category}`,
      p.answered_note && `How it was answered: ${p.answered_note}`,
    ].filter(Boolean).join('\n');
    const prompt = `Write a first-person testimony (about 80-140 words) celebrating this answered prayer, ` +
      `suitable to share with a prayer community. Warm, humble, specific, giving thanks to God.\n\n${detail}\n\n` +
      'Return JSON of the exact shape: {"title":"short title","body":"the testimony","verse":"one fitting verse with reference"}';
    const raw = await callClaude({
      model: AI_MODEL_CHAT, system,
      messages: [{ role: 'user', content: prompt }], maxTokens: 700,
    });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed || !parsed.body) return res.status(502).json({ error: 'could not generate testimony' });
    res.json({ title: parsed.title || 'Answered Prayer', body: parsed.body, verse: parsed.verse || '' });
  } catch (e) {
    console.error('ai/testimony error:', e.message);
    res.status(500).json({ error: 'Could not write a testimony right now.' });
  }
});

// Create a Stripe Checkout session for a donation to a cause
app.post('/api/donate/checkout', requireUser, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'stripe not configured' });
  const { causeId, causeName, amount } = req.body || {};
  const cents = Math.round(Number(amount) * 100);
  if (!causeId || !cents || cents < 50) return res.status(400).json({ error: 'invalid amount' });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: { name: `Donation — ${causeName || 'Cause'}` },
      },
    }],
    success_url: DONATION_SUCCESS_URL || `${WEB_ORIGIN}/?donated=1`,
    cancel_url: DONATION_CANCEL_URL || `${WEB_ORIGIN}/?donated=0`,
    metadata: { cause_id: causeId, cause_name: causeName || '', user_id: req.user.id },
  });
  res.json({ url: session.url });
});

// Send a notification by email and/or WhatsApp (e.g. confession request, reminder)
app.post('/api/notify', requireUser, async (req, res) => {
  const { email, whatsapp, subject = 'Prayer Vault', message = '' } = req.body || {};
  const out = { email: null, whatsapp: null };
  try {
    if (email && resend) {
      const r = await resend.emails.send({ from: EMAIL_FROM, to: email, subject, text: message });
      out.email = r?.data?.id || 'sent';
    }
    if (whatsapp && tw && TWILIO_WHATSAPP_FROM) {
      const to = whatsapp.startsWith('whatsapp:') ? whatsapp : `whatsapp:${whatsapp}`;
      const m = await tw.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body: message });
      out.whatsapp = m.sid;
    }
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get the user's Stripe customer id, creating (and remembering) one if needed.
async function getOrCreateCustomer(user) {
  if (admin) {
    const { data } = await admin.from('subscriptions')
      .select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    if (data?.stripe_customer_id) return data.stripe_customer_id;
  }
  const customer = await stripe.customers.create({
    email: user.email, metadata: { user_id: user.id },
  });
  if (admin) {
    await admin.from('subscriptions').upsert(
      { user_id: user.id, stripe_customer_id: customer.id },
      { onConflict: 'user_id' },
    );
  }
  return customer.id;
}

// Start a subscription Checkout for a tier ('Plus' | 'Church').
app.post('/api/subscribe/checkout', requireUser, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'stripe not configured' });
  const { plan } = req.body || {};
  const price = PLAN_TO_PRICE[plan];
  if (!price) return res.status(400).json({ error: 'unknown or unconfigured plan' });
  try {
    const customer = await getOrCreateCustomer(req.user);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer,
      client_reference_id: req.user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: req.user.id, plan } },
      success_url: BILLING_SUCCESS_URL || `${WEB_ORIGIN}/?upgraded=1`,
      cancel_url: BILLING_CANCEL_URL || `${WEB_ORIGIN}/?upgraded=0`,
      metadata: { user_id: req.user.id, plan },
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open the Stripe Customer Portal so the user can manage / cancel billing.
app.post('/api/billing/portal', requireUser, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'stripe not configured' });
  try {
    const customer = await getOrCreateCustomer(req.user);
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: BILLING_RETURN_URL || `${WEB_ORIGIN}/?page=profile`,
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Prayer Vault server on http://localhost:${PORT}`));
