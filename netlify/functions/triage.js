// ============================================================
// VINCENT ACTUAL TRIAGE ENGINE - NETLIFY FUNCTION
// File path in your repo: netlify/functions/triage.js
// ============================================================
//
// This is the backend that receives a ticket, calls Claude,
// and returns a structured diagnostic brief.
//
// DEPLOYMENT NOTES:
// 1. Put this file at: netlify/functions/triage.js
// 2. Set environment variable ANTHROPIC_API_KEY in Netlify dashboard
//    (Site settings -> Environment variables)
// 3. Netlify auto-deploys functions when you push to your repo
// ============================================================

const crypto = require('crypto');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // Fast + cheap, good for triage
const MAX_TICKET_LENGTH = 2000;
const IP_SALT = process.env.IP_SALT || 'va-default-salt-rotate-me';
const CAPTURE_RECIPIENT = 'info@vincentactual.com';

// Rate limiting: simple in-memory (resets on function cold start)
// For production, replace with a real rate limiter (Upstash Redis, etc.)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per IP per minute

const SYSTEM_PROMPT = `You are an expert MSP (Managed Service Provider) L1/L2 triage assistant. You have 15 years of experience working in MSPs supporting small and midsize businesses, including healthcare practices.

Your job: take an incomplete, messy support ticket and produce a structured diagnostic brief that an L2 engineer can act on immediately.

You will receive a raw ticket. Respond with a JSON object matching this exact schema:

{
  "category": "One of: M365, Endpoint, Network, Backup, Security, LOB Applications. Use the best fit. Include a subcategory after a slash if useful, e.g. 'M365 / Exchange Online'.",
  "priority": "One of: Low, Medium, High, Critical. Base this on user impact, business impact, and urgency signals in the ticket.",
  "missing_information": ["Array of specific information the L1 should have gathered but didn't. Be concrete. Include things like: exact error message, affected user count, OS version, recent changes, when it started, what was tried."],
  "probable_cause": "2 to 4 sentences. State the most likely root cause based on the symptoms described. If the ticket is too vague to determine, say so and state what the top 2-3 possibilities are.",
  "next_steps": ["Array of 4 to 7 concrete diagnostic or remediation steps, in the order an L2 engineer should try them. Start with the fastest checks. Be specific - reference actual tools, menus, or commands where appropriate."],
  "escalation_note": "A clean, PSA-ready internal note that an L1 could paste directly into ConnectWise, Autotask, or HaloPSA. Format: '[Category] - [one-line summary]. Probable cause: [brief]. Information needed from user: [list]. Recommended path: [brief].' Keep it under 6 lines."
}

Rules:
- Respond with ONLY the JSON object. No preamble, no markdown fences, no commentary.
- If the ticket is completely unintelligible or empty, return a JSON object with category "Unknown" and use the missing_information field to explain what's needed.
- Do not hallucinate details the ticket doesn't contain. If the ticket doesn't say what OS the user is on, don't invent one.
- Write in clear, professional MSP-engineer voice. No fluff. No corporate speak.
- Assume standard MSP tooling unless the ticket specifies otherwise: Microsoft 365, Entra ID, Autopilot-managed Windows endpoints, basic firewall/switch infrastructure.`;

exports.handler = async (event) => {
  // CORS headers - adjust origin for production
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Change to 'https://vincentactual.com' in production
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Rate limit check
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Too many requests. Please wait a moment.' })
    };
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const ticket = (body.ticket || '').trim();
  const consent = body.consent === true;
  const ipHash = crypto.createHash('sha256').update(clientIp + IP_SALT).digest('hex').slice(0, 16);
  const startedAt = new Date().toISOString();

  // Validate input
  if (!ticket) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Ticket text is required' })
    };
  }

  if (ticket.length > MAX_TICKET_LENGTH) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Ticket too long (max ${MAX_TICKET_LENGTH} chars)` })
    };
  }

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server not configured. Contact info@vincentactual.com.' })
    };
  }

  // Call Claude
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Raw ticket:\n\n${ticket}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', response.status, errorText);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Triage engine unavailable. Try again in a moment.' })
      };
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text || '';

    // Parse the JSON response from Claude
    let brief;
    try {
      // Strip any markdown code fences if present
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      brief = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse brief JSON:', rawText);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Brief format error. Try rephrasing the ticket.' })
      };
    }

    // Always log minimal metadata for traffic visibility and abuse detection.
    // Ticket body is only persisted if the user consented.
    console.log(`[TRIAGE] ${startedAt} | ip=${ipHash} | len=${ticket.length} | consent=${consent} | category=${brief.category || 'n/a'} | priority=${brief.priority || 'n/a'} | status=200`);

    if (consent) {
      // Full capture goes to function logs and (if configured) to email.
      console.log(`[TRIAGE-CAPTURE] ${JSON.stringify({ ts: startedAt, ip: ipHash, ticket, brief })}`);

      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        try {
          const subject = `[Triage] ${brief.category || 'Unknown'} | ${brief.priority || 'Unknown'}`;
          const emailBody = [
            `Timestamp: ${startedAt}`,
            `IP hash: ${ipHash}`,
            `Length: ${ticket.length} chars`,
            '',
            '--- TICKET ---',
            ticket,
            '',
            '--- BRIEF ---',
            JSON.stringify(brief, null, 2)
          ].join('\n');

          const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Vincent Actual <noreply@send.vincentactual.com>',
              to: [CAPTURE_RECIPIENT],
              subject,
              text: emailBody
            })
          });
          const resendBody = await resendRes.text();
          console.log(`[TRIAGE-RESEND] status=${resendRes.status} body=${resendBody}`);
        } catch (mailErr) {
          // Capture failures must never break the user-facing response.
          console.error('Capture email send failed:', mailErr);
        }
      } else {
        console.warn('[TRIAGE-RESEND] RESEND_API_KEY not set at runtime — skipping capture email');
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ brief })
    };

  } catch (err) {
    console.error('Triage function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal error. Try again.' })
    };
  }
};

function isRateLimited(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Window expired, reset
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return true;
  }

  record.count++;
  return false;
}
