// Vercel serverless function - no npm dependencies, so this deploys with
// zero build step alongside the static index.html (calls Stripe's REST
// API directly instead of pulling in the stripe SDK).
//
// Pricing is computed here from a fixed table, never trusted from the
// client - otherwise anyone could open dev tools and check out a 45-pack
// for a penny. The client only tells us which pack + quantity they want.

const PACKS = {
  restore: {
    1:  2.45,
    9:  2.19,
    19: 2.09,
    45: 1.99,
    41: 2.05,
    59: 1.99,
    95: 1.95,
  },
  // Hydrapro: Restore with more electrolytes + Bacillus coagulans.
  hydrapro: {
    5:  2.99,
    9:  2.79,
    19: 2.59,
    45: 2.49,
    41: 2.45,
    59: 2.38,
    95: 2.19,
  },
  // Mix: half Restore, half Hydrapro in one box, the odd stick being
  // Hydrapro (19 = 9 + 10). 60 is the monthly Mix membership (30 + 30).
  mix: {
    19: 2.39,
    45: 2.29,
    95: 2.19,
    60: 2.19,
  },
};

// Jars: powder with a scoop (one scoop = one stick), priced per scoop at
// $0.10-0.19 under the matching stick price. Mix jars are a pair of one
// Restore and one Hydrapro jar, priced at the average of the two. Jars are
// pre-orders that ship in January 2027.
const JARS = {
  restore:  { 45: 1.89, 95: 1.80, 195: 1.76 },
  hydrapro: { 45: 2.39, 95: 2.05, 195: 2.00 },
  mix:      { 90: 2.14, 190: 1.92, 390: 1.88 },
};

// Jar subscriptions: a jar every month at $0.10 a scoop under the one-off
// jar. The card is saved now and first charged when jars ship (Stripe trial
// until JAR_FIRST_CHARGE), then monthly.
const JAR_SUBS = {
  restore:  { 45: 1.79, 95: 1.70, 195: 1.66 },
  hydrapro: { 45: 2.29, 95: 1.95, 195: 1.90 },
  mix:      { 90: 2.04, 190: 1.82, 390: 1.78 },
};
const JAR_FIRST_CHARGE = Date.UTC(2027, 0, 4, 15) / 1000;   // Mon Jan 4, 2027, 10am ET

// These sizes aren't one-off purchases - they're the monthly membership
// tiers, billed by Stripe every month until cancelled. Always exactly one
// per checkout, whatever quantity the client sends.
const MEMBERSHIP_STICKS = {
  restore:  [41, 59, 95],
  hydrapro: [41, 59, 95],
  mix:      [60],
};
const PRODUCT_NAME = { restore: "Restore", hydrapro: "Hydrapro", mix: "Mix (half Restore, half Hydrapro)" };

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

  const product = ["restore", "hydrapro", "mix"].includes(body.product) ? body.product : "restore";
  const sticks = Number(body.sticks);
  const jarSub = body.format === "jarsub";
  const jar    = body.format === "jar" || jarSub;
  const member = jarSub || (!jar && MEMBERSHIP_STICKS[product].includes(sticks));
  const qty    = member ? 1 : Math.max(1, Math.min(20, Math.floor(Number(body.qty)) || 1));
  const orderRef = String(body.orderRef || "").slice(0, 40);
  const name   = String(body.name  || "").slice(0, 200);
  const email  = String(body.email || "").slice(0, 200);

  const table = jarSub ? JAR_SUBS : jar ? JARS : PACKS;
  const unit = Object.prototype.hasOwnProperty.call(table[product], sticks) ? table[product][sticks] : 0;
  if (!unit) {
    res.status(400).json({ error: "Unknown pack size" });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "Stripe isn't configured on this deployment yet" });
    return;
  }

  const unitAmountCents = Math.round(sticks * unit * 100);
  // only send Stripe back to our own domains (or a Vercel preview), never a spoofed Host header
  const host = String(req.headers.host || "");
  const origin = /(^|\.)drinkhydraco\.com$|\.vercel\.app$/i.test(host)
    ? "https://" + host
    : "https://www.drinkhydraco.com";

  const params = new URLSearchParams();
  params.set("mode", member ? "subscription" : "payment");
  params.set("success_url", origin + "/?paid=1&ref=" + encodeURIComponent(orderRef) + "&session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url",  origin + "/?cancelled=1#order");
  params.set("line_items[0][quantity]", String(qty));
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
  params.set("line_items[0][price_data][product_data][name]", jarSub
    ? "Hydraco " + PRODUCT_NAME[product] + " jar subscription — one " + sticks + "-scoop jar"
      + (product === "mix" ? " pair" : "") + " every month (first charge January 2027)"
    : member
    ? "Hydraco " + PRODUCT_NAME[product] + " Membership — " + sticks + " Strawberry Lemonade stick packs every month"
    : jar
    ? "Hydraco " + PRODUCT_NAME[product] + ", Strawberry Lemonade — " + sticks + "-scoop jar"
      + (product === "mix" ? " pair" : "") + " (ships January 2027)"
    : "Hydraco " + PRODUCT_NAME[product] + ", Strawberry Lemonade — " + sticks + "-pack");
  if (member) {
    params.set("line_items[0][price_data][recurring][interval]", "month");
    // session metadata doesn't carry over to the subscription Stripe creates,
    // so repeat the order reference there for matching renewals later
    params.set("subscription_data[metadata][order_ref]", orderRef);
    params.set("subscription_data[metadata][name]", name);
    params.set("subscription_data[metadata][product]", product);
    // jars don't exist yet: no charge until they ship (Stripe needs the trial to end 48h+ from now)
    if (jarSub && JAR_FIRST_CHARGE > Date.now() / 1000 + 2 * 86400) {
      params.set("subscription_data[trial_end]", String(JAR_FIRST_CHARGE));
    }
  }
  if (email) { params.set("customer_email", email); }
  params.set("metadata[order_ref]", orderRef);
  params.set("metadata[name]", name);
  params.set("metadata[product]", product);
  params.set("metadata[sticks]", String(sticks));
  params.set("metadata[format]", jarSub ? "jarsub" : jar ? "jar" : "stick");
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
