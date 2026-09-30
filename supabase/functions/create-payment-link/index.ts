// Creates a Papi (papi.mg) payment link server-side, so the Papi API
// key never reaches the browser, and converts the USD amount shown on
// the site into MGA (Papi only accepts MGA) using a live exchange rate.
//
// Deploy:
//   supabase functions deploy create-payment-link --project-ref shcluyfdwiqhrbzttxhk
// Set the secret once (never commit the real key):
//   supabase secrets set PAPI_API_KEY=your_real_key --project-ref shcluyfdwiqhrbzttxhk
//
// Docs: https://docs.papi.mg/docs/quickstart/

const PAPI_ENDPOINT = "https://app.papi.mg/engine/api/payment-links";
const RATE_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
const RATE_CACHE_MS = 6 * 60 * 60 * 1000; // refresh at most every 6h
const FALLBACK_USD_TO_MGA = 4500; // used only if the rate API is unreachable

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Module-scope cache — persists across invocations on a warm instance.
let cachedRate: { mgaPerUsd: number; fetchedAt: number } | null = null;

async function getUsdToMga(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < RATE_CACHE_MS) {
    return cachedRate.mgaPerUsd;
  }
  try {
    const res = await fetch(RATE_ENDPOINT);
    const data = await res.json();
    const rate = data?.rates?.MGA;
    if (typeof rate === "number" && rate > 0) {
      cachedRate = { mgaPerUsd: rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch (err) {
    console.error("Rate lookup failed, using fallback:", err);
  }
  return cachedRate?.mgaPerUsd ?? FALLBACK_USD_TO_MGA;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    amountUsd, clientName, reference, description,
    payerEmail, payerPhone, successUrl, failureUrl,
  } = body as {
    amountUsd?: number; clientName?: string; reference?: string; description?: string;
    payerEmail?: string; payerPhone?: string; successUrl?: string; failureUrl?: string;
  };

  if (typeof amountUsd !== "number" || !(amountUsd > 0)) {
    return json({ error: "amountUsd must be a positive number" }, 400);
  }
  if (!clientName || !reference || !description) {
    return json({ error: "clientName, reference and description are required" }, 400);
  }

  const apiKey = Deno.env.get("PAPI_API_KEY");
  if (!apiKey) {
    console.error("PAPI_API_KEY is not set — run: supabase secrets set PAPI_API_KEY=...");
    return json({ error: "Payment is not configured yet." }, 500);
  }

  const mgaPerUsd = await getUsdToMga();
  const amountMga = Math.max(300, Math.round(amountUsd * mgaPerUsd));

  const payload: Record<string, unknown> = {
    amount: amountMga,
    clientName,
    reference,
    description,
  };
  if (payerEmail) payload.payerEmail = payerEmail;
  if (payerPhone) payload.payerPhone = payerPhone;
  if (successUrl) payload.successUrl = successUrl;
  if (failureUrl) payload.failureUrl = failureUrl;

  let papiRes: Response;
  try {
    papiRes = await fetch(PAPI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": apiKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Papi request failed:", err);
    return json({ error: "Could not reach the payment provider." }, 502);
  }

  const papiJson = await papiRes.json().catch(() => null);

  if (!papiRes.ok || !papiJson?.data?.paymentLink) {
    console.error("Papi error:", papiRes.status, papiJson);
    return json({ error: "Could not create the payment link." }, 502);
  }

  return json({
    paymentLink: papiJson.data.paymentLink,
    paymentReference: papiJson.data.paymentReference,
    amountMga,
    mgaPerUsd,
  }, 200);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
