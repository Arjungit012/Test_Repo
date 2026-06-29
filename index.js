/**
 * MSS WhatsApp Webhook — Render Express Server
 *
 * ENV VARS (set in Render dashboard → Environment):
 *   WHATSAPP_VERIFY_TOKEN   — mss_ops_token_byArjun
 *   WHATSAPP_API_TOKEN      — long Meta access token
 *   WHATSAPP_PHONE_ID       — MSS WhatsApp phone number ID from Meta
 *   SUPABASE_URL            — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    — service_role key (NOT anon key)
 *
 * META SETUP:
 *   Callback URL:  https://<your-render-app>.onrender.com/
 *   Verify token:  mss_ops_token_byArjun
 *   Subscribe to:  messages
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// ─── helpers ──────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars");
  return createClient(url, key);
}

function extractMessage(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return null;
    const msg = value.messages[0];
    const contact = value?.contacts?.[0];
    return {
      phone:         msg.from,
      name:          contact?.profile?.name || "Unknown",
      messageType:   msg.type,
      messageText:   msg?.text?.body || "",
      waMessageId:   msg.id,
      phoneNumberId: value?.metadata?.phone_number_id,
    };
  } catch {
    return null;
  }
}

function formatPhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) {
    const num = digits.slice(2);
    return `+91 ${num.slice(0, 5)} ${num.slice(5)}`;
  }
  return `+${digits}`;
}

async function assignSP(supabase) {
  const { data } = await supabase
    .from("leads")
    .select("assigned_sp")
    .in("stage", ["new_lead", "price_shared", "followup"]);
  if (!data || data.length === 0) return 1;
  const sp1 = data.filter(l => l.assigned_sp === 1).length;
  const sp2 = data.filter(l => l.assigned_sp === 2).length;
  return sp1 <= sp2 ? 1 : 2;
}

async function generateRef(supabase) {
  const { data } = await supabase
    .from("leads")
    .select("order_ref")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return "MSS-0001";
  const num = parseInt((data[0].order_ref || "MSS-0000").replace("MSS-", "")) + 1;
  return `MSS-${String(num).padStart(4, "0")}`;
}

async function sendGreeting(phone, name, orderRef) {
  const firstName = (name || "there").split(" ")[0];
  const message =
    `Hi ${firstName}! 👋 Welcome to *My Surprise Studio*.\n\n` +
    `We create personalised teak wood engravings, LED frames, and custom gifts.\n\n` +
    `Someone from our team will reach out to you shortly 🎁\n\n` +
    `Your reference number is *${orderRef}* — keep this handy!`;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: message },
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      console.error("WhatsApp greeting failed:", err);
    } else {
      console.log("Greeting sent to", phone);
    }
  } catch (e) {
    console.error("sendGreeting fetch error:", e.message);
  }
}

// ─── GET: Meta webhook verification ──────────────────────────────────────────

app.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("GET verify hit — query:", JSON.stringify(req.query));

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    return res.status(200).send(challenge);
  }

  if (!mode && !token && !challenge) {
    console.log("Bare GET probe — returning 200");
    return res.status(200).send("OK");
  }

  console.log("Verification failed — mode:", mode, "token:", token);
  return res.status(403).send("Forbidden");
});

// ─── POST: incoming WhatsApp message ─────────────────────────────────────────

app.post("/", async (req, res) => {
  // Always respond 200 immediately — Meta retries if we're slow
  console.log("TEST POST hit:", JSON.stringify(req.body));
  res.status(200).json({ status: "ok" });

  try {
    const body = req.body;
    console.log("POST received:", JSON.stringify(body, null, 2));

    const msg = extractMessage(body);

    if (!msg) {
      console.log("No message in payload — status update or non-message event, ignoring");
      return;
    }

    // Safety: only process messages from our own phone number
    if (process.env.WHATSAPP_PHONE_ID && msg.phoneNumberId !== process.env.WHATSAPP_PHONE_ID) {
      console.log("Ignored message for different phone ID:", msg.phoneNumberId);
      return;
    }

    const supabase = getSupabase();
    const phone = formatPhone(msg.phone);

    // Duplicate check
    const { data: existing } = await supabase
      .from("leads")
      .select("id, order_ref, stage")
      .eq("phone", phone)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`Existing lead ${existing[0].order_ref} messaged — stage: ${existing[0].stage}`);
      await supabase.from("activity_log").insert({
        lead_id:    existing[0].id,
        actor_role: "customer",
        action:     "whatsapp_message",
        detail:     (msg.messageText || "").slice(0, 200),
      });
      return;
    }

    // New lead
    const [sp, orderRef] = await Promise.all([assignSP(supabase), generateRef(supabase)]);

    const { data: newLead, error } = await supabase
      .from("leads")
      .insert({
        order_ref:      orderRef,
        customer_name:  msg.name,
        phone:          phone,
        product:        "To be confirmed",
        custom_text:    "",
        stage:          "new_lead",
        assigned_sp:    sp,
        payment_status: "pending",
        amount_total:   0,
        amount_paid:    0,
        note:           msg.messageText
                          ? `First message: "${msg.messageText.slice(0, 150)}"`
                          : "Came from Meta ad — no message",
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase lead insert failed:", JSON.stringify(error));
      return;
    }

    await Promise.all([
      supabase.from("production").insert({ lead_id: newLead.id }),
      supabase.from("dispatch").insert({ lead_id: newLead.id }),
      supabase.from("activity_log").insert({
        lead_id:    newLead.id,
        actor_role: "system",
        action:     "lead_created",
        detail:     `Auto-created from WhatsApp. Assigned SP${sp}.`,
      }),
    ]);

    await sendGreeting(msg.phone, msg.name, orderRef);

    console.log(`Lead created: ${orderRef} — ${msg.name} (${phone}) → SP${sp}`);

  } catch (err) {
    console.error("Webhook handler error:", err.message, err.stack);
  }
});

// ─── start ────────────────────────────────────────────────────────────────────

app.listen(port, () => console.log(`MSS webhook listening on port ${port}`));
