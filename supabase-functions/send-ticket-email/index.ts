// Supabase Edge Function: send-ticket-email
//
// Triggered via HTTP (e.g. from a Postgres trigger using supabase_functions.http_request).
// Expects a JSON body: { record: { name, email, ticket_id, event_name } }
//
// This example uses Resend for email delivery.
// In your Supabase project, set the following environment variables for this function:
// - RESEND_API_KEY       – your Resend API key
// - EMAIL_FROM           – from-address, e.g. "BLOCK Tickets <tickets@yourdomain.com>"
// - BASE_URL             – base URL of your site, e.g. "https://your-domain.com"

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import QRCode from "npm:qrcode";
import { Resend } from "npm:resend";

interface AttendeeRecord {
  name: string | null;
  email: string | null;
  ticket_id: string | null;
  event_name: string | null;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const record: AttendeeRecord | undefined = body?.record;
  if (!record || !record.email || !record.ticket_id) {
    return new Response("Missing record/email/ticket_id", { status: 400 });
  }

  const baseUrl = Deno.env.get("BASE_URL") || "http://localhost:3001";
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("EMAIL_FROM") ?? "";

  if (!resendKey || !from) {
    console.warn("send-ticket-email: RESEND_API_KEY or EMAIL_FROM not set");
    return new Response("Email not configured", { status: 503 });
  }

  const resend = new Resend(resendKey);

  const name = (record.name || "").trim();
  const email = record.email.trim();
  const ticketId = record.ticket_id.trim();
  const eventName = (record.event_name || "Event").trim();

  const checkInUrl = `${baseUrl}/checkin/${ticketId}`;
  const ticketUrl = `${baseUrl}/ticket/${ticketId}`;

  // Generate QR code PNG buffer for the check-in URL
  const qrPng = await QRCode.toBuffer(checkInUrl, { width: 400, margin: 2 });
  const qrBase64 = qrPng.toString("base64");
  const qrDataUrl = `data:image/png;base64,${qrBase64}`;

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827;">
      <div style="margin-bottom: 20px;">
        <img src="${baseUrl}/block-logo.png" alt="BLOCK" width="120" style="display:block;height:auto;filter:brightness(2.4);" />
      </div>
      <h2 style="font-size: 20px; margin-bottom: 12px;">You're registered for ${eventName}</h2>
      <p style="margin: 0 0 12px;">Hi ${name || "there"},</p>
      <p style="margin: 0 0 12px;">Your unique ticket is attached. Show this QR code at the entrance to check in.</p>
      <p style="margin: 16px 0;">
        <img src="${qrDataUrl}" alt="QR Code" style="display:block;max-width:280px;height:auto;" />
      </p>
      <p style="margin: 0 0 12px;">You can also open your ticket here on the day:</p>
      <p style="margin: 0 0 12px;">
        <a href="${ticketUrl}">${ticketUrl}</a>
      </p>
      <p style="margin: 0 0 12px;">Ticket ID: <strong>${ticketId}</strong></p>
      <p style="margin: 12px 0 0;">See you there!</p>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from,
      to: email,
      subject: `Your ticket for ${eventName}`,
      html,
      attachments: [
        {
          filename: "ticket-qr.png",
          content: qrBase64,
        },
      ],
    });

    if (result.error) {
      console.error("send-ticket-email error:", result.error);
      return new Response("Failed to send email", { status: 500 });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("send-ticket-email exception:", err);
    return new Response("Failed to send email", { status: 500 });
  }
});

