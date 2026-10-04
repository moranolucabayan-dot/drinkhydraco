// Vercel serverless function - no npm dependencies, so this deploys with
// zero build step alongside the static index.html (calls Stripe's REST
// API directly instead of pulling in the stripe SDK).
//
// Pricing is computed here from a fixed table, never trusted from the
// client - otherwise anyone could open dev tools and check out a 45-pack
// for a penny. The client only tells us which pack + quantity they want.

const PACKS = {
  1:  2.45,
  9:  2.19,
  19: 2.09,
  45: 1.99,
  41: 2.05,
  59: 1.99,
  95: 1.95,
};

// These sizes aren't one-off purchases - they're the monthly membership
// tiers, billed by Stripe every month until cancelled. Always exactly one
// per checkout, whatever quantity the client sends.
const MEMBERSHIP_STICKS = [41, 59, 95];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const sticks = Number(body.sticks);
  const member = MEMBERSHIP_STICKS.includes(sticks);
  const qty    = member ? 1 : Math.max(1, Math.min(20, Math.floor(Number(body.qty)) || 1));
  const orderRef = String(body.orderRef || "").slice(0, 40);
  const name   = String(body.name  || "").slice(0, 200);
  const email  = String(body.email || "").slice(0, 200);

  const unit = PACKS[sticks];
  if (!unit) {
    res.status(400).json({ error: "Unknown pack size" });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "Stripe isn't configured on this deployment yet" });
    return;
  }

  const unitAmountCents = Math.round(sticks * unit * 100);
  const origin = "https://" + req.headers.host;

  const params = new URLSearchParams();
  params.set("mode", member ? "subscription" : "payment");
  params.set("success_url", origin + "/?paid=1&ref=" + encodeURIComponent(orderRef) + "&session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url",  origin + "/?cancelled=1#order");
  params.set("line_items[0][quantity]", String(qty));
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
  params.set("line_items[0][price_data][product_data][name]", member
    ? "Hydraco Membership — " + sticks + " stick packs every month"
    : "Hydraco Restore — " + sticks + "-pack");
  if (member) {
    params.set("line_items[0][price_data][recurring][interval]", "month");
    // session metadata doesn't carry over to the subscription Stripe creates,
    // so repeat the order reference there for matching renewals later
    params.set("subscription_data[metadata][order_ref]", orderRef);
    params.set("subscription_data[metadata][name]", name);
  }
  if (email) { params.set("customer_email", email); }
  params.set("metadata[order_ref]", orderRef);
  params.set("metadata[name]", name);
  params.set("metadata[sticks]", String(sticks));
  params.set("metadata[qty]", String(qty));

  try {
    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await stripeResp.json();
    if (!stripeResp.ok) {
      res.status(502).json({ error: (data.error && data.error.message) || "Stripe error" });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: "Could not reach Stripe" });
  }
};
