// Supabase Edge Function: notify-admin
// Triggered by Database Webhooks on INSERT into `confessions` and `donations`.
// Emails ADMIN_EMAIL via Resend. Runs on Supabase's infra — no always-on server.
//
// Deploy:  supabase functions deploy notify-admin --no-verify-jwt
// Secrets: supabase secrets set RESEND_API_KEY=... EMAIL_FROM="Prayer Vault <noreply@yourdomain.com>" \
//                              ADMIN_EMAIL=you@example.com NOTIFY_WEBHOOK_SECRET=some-long-random-string
//
// Privacy: confession emails NEVER include the message body — only a heads-up
// to open the dashboard. Sensitive content stays inside the protected database.

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Prayer Vault <onboarding@resend.dev>";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "";
const WEBHOOK_SECRET = Deno.env.get("NOTIFY_WEBHOOK_SECRET") ?? "";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendEmail(subject: string, text: string): Promise<void> {
  if (!RESEND_API_KEY || !ADMIN_EMAIL) {
    console.error("notify-admin: missing RESEND_API_KEY or ADMIN_EMAIL — skipping send");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: ADMIN_EMAIL, subject, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  // Shared-secret check. Configure the webhook to send this header.
  if (WEBHOOK_SECRET) {
    const provided =
      req.headers.get("x-webhook-secret") ??
      (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (provided !== WEBHOOK_SECRET) return json(401, { error: "unauthorized" });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  if (payload.type !== "INSERT" || !payload.record) {
    return json(200, { ok: true, skipped: "not an insert" });
  }

  const r = payload.record;
  try {
    if (payload.table === "confessions") {
      // Privacy-preserving: recipient + contact only, NEVER the message body.
      const recipient = (r.priest as string) || "a priest";
      const contact = (r.contact as string) || "(no contact given)";
      await sendEmail(
        "🕊️ New confession request — Prayer Vault",
        [
          `A new confession / spiritual-counsel request was submitted.`,
          ``,
          `Requested recipient: ${recipient}`,
          `Contact: ${contact}`,
          `Received: ${(r.created_at as string) || new Date().toISOString()}`,
          ``,
          `The message itself is private — open your Supabase dashboard`,
          `(Table editor → confessions) to read and respond.`,
        ].join("\n"),
      );
    } else if (payload.table === "donations") {
      const amount = Number(r.amount ?? 0);
      const currency = ((r.currency as string) || "usd").toUpperCase();
      const cause = (r.cause_name as string) || "a cause";
      const status = (r.status as string) || "pending";
      await sendEmail(
        `💝 New donation: ${currency} ${amount.toFixed(2)} — Prayer Vault`,
        [
          `A donation was just recorded.`,
          ``,
          `Cause: ${cause}`,
          `Amount: ${currency} ${amount.toFixed(2)}`,
          `Status: ${status}`,
          `Received: ${(r.created_at as string) || new Date().toISOString()}`,
        ].join("\n"),
      );
    } else {
      return json(200, { ok: true, skipped: `unhandled table ${payload.table}` });
    }
  } catch (e) {
    console.error("notify-admin send failed:", e);
    return json(500, { ok: false, error: (e as Error).message });
  }

  return json(200, { ok: true });
});
