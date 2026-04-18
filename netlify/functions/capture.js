// ============================================================
// VINCENT ACTUAL EMAIL CAPTURE - NETLIFY FUNCTION
// File path in your repo: netlify/functions/capture.js
// ============================================================
//
// This receives email signups from the demo capture form and
// emails them to you at info@vincentactual.com.
//
// DEPLOYMENT NOTES:
// 1. Put this file at: netlify/functions/capture.js
// 2. You have two options for where leads go:
//    OPTION A (simplest): Use Netlify's built-in Forms feature
//       - This requires changing the frontend form to use Netlify Forms
//       - See: https://docs.netlify.com/forms/setup/
//    OPTION B (current setup): Use a third-party email API
//       - Requires signup at Resend (resend.com) - free tier is 100/day
//       - Set RESEND_API_KEY in Netlify environment variables
//       - This is what this function uses
//
// For now, this function logs the capture to the Netlify function log
// and optionally sends via Resend if RESEND_API_KEY is set.
// You'll see captures in: Netlify dashboard -> Functions -> capture -> logs
// ============================================================

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

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

  const email = (body.email || '').trim().toLowerCase();
  const source = body.source || 'unknown';

  // Basic email validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid email' })
    };
  }

  // ALWAYS log the capture so you can see it in Netlify function logs
  // even if the email send fails
  const timestamp = new Date().toISOString();
  console.log(`[CAPTURE] ${timestamp} | ${email} | source: ${source}`);

  // Optional: send email notification via Resend
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Vincent Actual <noreply@vincentactual.com>',
          to: ['info@vincentactual.com'],
          subject: `New design partner interest: ${email}`,
          text: `New capture from ${source}\n\nEmail: ${email}\nTimestamp: ${timestamp}\n\nFollow up within 48 hours.`
        })
      });
    } catch (err) {
      // Don't fail the request if email send fails - we already logged it
      console.error('Email send failed:', err);
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true })
  };
};
