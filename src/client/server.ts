import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getAllUserTabs,
  getUserSettingsMap,
  updateLastAutoSummaryDate,
  guessTimezoneFromPhone,
  updateLastInactivityCheck,
  updateLastLogDate,
  updateUserTwilioAccountSid
} from '../services/sheets';
import { downloadTwilioMedia, createTwiMLReply, sendProactiveWhatsAppMessage } from '../services/twilio';
import twilio from 'twilio';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (e.g. Railway's load balancer) to ensure correct protocol detection for Twilio validation
app.set('trust proxy', true);

// Enable CORS for flexibility
app.use(cors());

// Twilio sends application/x-www-form-urlencoded payloads to webhooks.
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));

// Serve saved food images statically so they are publicly accessible via the tunnel URL
app.use('/images', express.static(path.join(__dirname, '../../public/images')));

// A simple health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'WhatsApp Food Log Webhook Server is running.' });
});

// Configure Twilio Webhook Signature Verification (only verify if explicitly requested)
const shouldVerifyTwilio = process.env.TWILIO_VERIFY_SIGNATURE === 'true';
const webhookMiddleware = shouldVerifyTwilio
  ? twilio.webhook()
  : (req: express.Request, res: express.Response, next: express.NextFunction) => next();

// MCP Client logic
let mcpClient: Client | null = null;
let isConnecting = false;

async function initMcpClientWithRetry(retries = 30, delayMs = 5000): Promise<void> {
  if (isConnecting) return;
  isConnecting = true;

  const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3001/sse';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Webhook Server] Connecting to standalone MCP Server over SSE: ${mcpServerUrl} (Attempt ${attempt}/${retries})`);
      const transport = new SSEClientTransport(new URL(mcpServerUrl));
      
      const client = new Client(
        {
          name: "food-tracker-webhook-client",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );

      await client.connect(transport);
      console.log('[Webhook Server] Handshake complete, connected to MCP Server.');
      mcpClient = client;
      isConnecting = false;

      // Handle connection close event
      transport.onclose = () => {
        console.warn('[Webhook Server] MCP Server connection closed. Resetting client.');
        mcpClient = null;
        // Trigger auto-reconnect sequence in the background
        initMcpClientWithRetry(100, 5000).catch(() => {});
      };
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Webhook Server] Connection attempt ${attempt}/${retries} failed: ${errMsg}`);
      if (attempt < retries) {
        console.log(`[Webhook Server] Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  isConnecting = false;
  throw new Error(`Failed to connect to MCP Server after ${retries} attempts.`);
}

async function ensureMcpClientConnected(): Promise<void> {
  if (mcpClient) return;
  console.log('[Webhook Server] MCP Client not connected. Attempting initialization...');
  await initMcpClientWithRetry(5, 2000);
}

function getSanitizedJsonRpcRequest(name: string, args: any, id: number) {
  const sanitizedArgs = { ...args };
  if (sanitizedArgs.images && Array.isArray(sanitizedArgs.images)) {
    sanitizedArgs.images = sanitizedArgs.images.map((img: any) => ({
      ...img,
      base64: img.base64 ? `[base64: ${img.base64.length} chars]` : undefined
    }));
  }
  return {
    jsonrpc: "2.0",
    method: `tools/call`,
    params: {
      name,
      arguments: sanitizedArgs
    },
    id
  };
}

async function callMcpTool(name: string, args: any): Promise<string> {
  await ensureMcpClientConnected();
  if (!mcpClient) {
    throw new Error('MCP Client is not connected to the MCP Server.');
  }

  // Format and print JSON-RPC request log (sanitized)
  const requestId = Math.floor(Math.random() * 1000000);
  const logRequest = getSanitizedJsonRpcRequest(name, args, requestId);

  console.log(`\n================================================================================`);
  console.log(`[Webhook Server] ---> SENDING JSON-RPC REQUEST TO MCP SERVER`);
  console.log(JSON.stringify(logRequest, null, 2));
  console.log(`================================================================================\n`);

  const response = await mcpClient.callTool({
    name,
    arguments: args
  }) as any;

  // Format and print JSON-RPC response log
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    result: response,
    id: requestId
  };

  console.log(`\n================================================================================`);
  console.log(`[Webhook Server] <--- RECEIVED JSON-RPC RESPONSE FROM MCP SERVER`);
  console.log(JSON.stringify(jsonRpcResponse, null, 2));
  console.log(`================================================================================\n`);

  if (response.isError) {
    throw new Error(response.content?.[0]?.text || `Unknown error executing tool ${name}`);
  }
  return response.content?.[0]?.text || '';
}

async function callMcpToolDetailed(name: string, args: any): Promise<any> {
  await ensureMcpClientConnected();
  if (!mcpClient) {
    throw new Error('MCP Client is not connected to the MCP Server.');
  }

  const requestId = Math.floor(Math.random() * 1000000);
  const logRequest = getSanitizedJsonRpcRequest(name, args, requestId);

  console.log(`\n================================================================================`);
  console.log(`[Webhook Server] ---> SENDING JSON-RPC REQUEST TO MCP SERVER (DETAILED)`);
  console.log(JSON.stringify(logRequest, null, 2));
  console.log(`================================================================================\n`);

  const response = await mcpClient.callTool({
    name,
    arguments: args
  }) as any;

  const jsonRpcResponse = {
    jsonrpc: "2.0",
    result: response,
    id: requestId
  };

  console.log(`\n================================================================================`);
  console.log(`[Webhook Server] <--- RECEIVED JSON-RPC RESPONSE FROM MCP SERVER (DETAILED)`);
  console.log(JSON.stringify(jsonRpcResponse, null, 2));
  console.log(`================================================================================\n`);

  if (response.isError) {
    throw new Error(response.content?.[0]?.text || `Unknown error executing tool ${name}`);
  }
  return response;
}

// The main webhook route that receives messages from Twilio
app.post('/webhook', webhookMiddleware, async (req, res) => {
  console.log('[Webhook Server] --- Received incoming webhook request ---');

  const { Body, NumMedia, From, To, AccountSid } = req.body;
  const numMediaCount = parseInt(NumMedia || '0', 10);

  if ((Body || '').trim().toLowerCase().startsWith('join ')) {
    console.log(`[Webhook Server] [Twilio Sandbox] 🎉 New user joined the sandbox! Sender: ${From}`);
  }

  console.log(`[Webhook Server] From: ${From}`);
  console.log(`[Webhook Server] To: ${To}`);
  console.log(`[Webhook Server] Account SID: ${AccountSid}`);
  console.log(`[Webhook Server] Body text: ${Body || '(empty)'}`);
  console.log(`[Webhook Server] Number of media files detected in webhook: ${numMediaCount}`);

  // Set the response content-type to XML for Twilio TwiML
  res.header('Content-Type', 'text/xml');

  const cleanedSender = (From || 'whatsapp:Sheet1').replace('whatsapp:', '');
  const profileName = req.body.ProfileName || 'User';

  if (AccountSid) {
    // Dynamically bind the user to the Twilio Account SID they just messaged
    updateUserTwilioAccountSid(cleanedSender, AccountSid)
      .catch(err => console.error(`[Webhook Server] Failed to save Twilio Account SID mapping for ${cleanedSender}:`, err));
  }

  // Case 1: No media was sent. Check if the user is requesting a nutrition summary report or changing settings.
  if (numMediaCount === 0) {
    const bodyText = (Body || '').trim().toLowerCase();
    const isOptOutRequest = bodyText.includes('opt out') || bodyText.includes('stop summary') || bodyText.includes('unsubscribe') || bodyText.includes('no summary');
    const isOptInRequest = bodyText.includes('opt in') || bodyText.includes('start summary') || bodyText.includes('subscribe');
    const isSummaryRequest = bodyText.includes('summary') || bodyText.includes('report') || bodyText.includes('digest');
    const isInactivityRequest = bodyText === 'inspire' || bodyText === 'motivate' || bodyText === 'inactivity' || bodyText === 'inspiration';

    // Handle On-Demand Inactivity/Inspiration Request
    if (isInactivityRequest) {
      res.status(200).send(createTwiMLReply("⏳ *Fetching inspiration from your logging history...* 🔍"));
      (async () => {
        try {
          console.log(`[Webhook Server] On-demand inactivity check requested by ${cleanedSender}`);
          const inspirationMsg = await callMcpTool("get_inactivity_inspiration", {
            phone: cleanedSender,
            profileName
          });
          await sendProactiveWhatsAppMessage(From, inspirationMsg, undefined, AccountSid);
        } catch (err) {
          console.error('[Webhook Server] Error generating on-demand inspiration:', err);
          await sendProactiveWhatsAppMessage(From, "⚠️ Sorry, I ran into an error generating your inspiration reminder.", undefined, AccountSid);
        }
      })();
      return;
    }

    // Handle Opt-Out Request
    if (isOptOutRequest) {
      try {
        console.log(`[Webhook Server] Opt-out request received from ${cleanedSender}`);
        await callMcpTool("update_settings", { phone: cleanedSender, status: "opt-out" });
        const replyMsg =
          `🔕 *Daily Summary Disabled* 🔕

You have successfully opted out of receiving proactive daily summary reports at 9:00 PM.

• You can still request summaries on-demand anytime by texting *"summary"*.
• You can reactivate daily reports anytime by texting *"opt in"*!

⚠️ *Note: Nutritional estimates are AI-generated and may have inaccuracies. Use for general tracking only.*`;
        return res.status(200).send(createTwiMLReply(replyMsg));
      } catch (err) {
        console.error('[Webhook Server] Error during opt-out:', err);
        return res.status(200).send(createTwiMLReply("⚠️ Sorry, I ran into an error updating your daily digest settings. Please try again in a moment!"));
      }
    }

    // Handle Opt-In Request
    if (isOptInRequest) {
      try {
        console.log(`[Webhook Server] Opt-in request received from ${cleanedSender}`);
        await callMcpTool("update_settings", { phone: cleanedSender, status: "opt-in" });
        const replyMsg =
          `🔔 *Daily Summary Enabled* 🔔

You have successfully opted in! I will proactively text you your personalized nutrition progress report **every night as an end-of-day update**.

⚠️ *Note: Nutritional estimates are AI-generated and may have inaccuracies. Use for general tracking only.*`;
        return res.status(200).send(createTwiMLReply(replyMsg));
      } catch (err) {
        console.error('[Webhook Server] Error during opt-in:', err);
        return res.status(200).send(createTwiMLReply("⚠️ Sorry, I ran into an error updating your daily digest settings. Please try again in a moment!"));
      }
    }

    // Handle Summary Request (Only supports today's daily summary)
    if (isSummaryRequest) {
      // 1. Reply to Twilio instantly to prevent timeout
      res.status(200).send(createTwiMLReply("⏳ *Generating today's nutrition digest...* Give me a moment to review your logged meals! 🔍"));

      // 2. Process in background
      (async () => {
        try {
          const now = new Date();
          const dateString = now.toLocaleDateString('en-US'); // Will look up today's logs
          const responseObj = await callMcpToolDetailed("get_daily_summary", { phone: cleanedSender, profileName, dateString, allowFallbackDays: 3 });

          const summaryText = responseObj.content?.[0]?.text || '';
          await sendProactiveWhatsAppMessage(From, summaryText, undefined, AccountSid);
        } catch (err: any) {
          console.error('[Webhook Server] Error generating nutrition summary in background:', err);
          const errStr = (err.message || '') + ' ' + (err.status || '') + ' ' + JSON.stringify(err);
          const isRateLimit = errStr.includes('429') ||
            errStr.toLowerCase().includes('resource_exhausted') ||
            errStr.toLowerCase().includes('resource exhausted') ||
            errStr.toLowerCase().includes('quota exceeded');

          if (isRateLimit) {
            const funnyMsg = "⚠️ *Hold your forks!* 🍴 You're requesting summaries faster than a competitive eater at a buffet! The AI coach is currently out of breath. Give me a minute to digest and try again! 🏃‍♂️💨";
            await sendProactiveWhatsAppMessage(From, funnyMsg, undefined, AccountSid);
            return;
          }

          const errMsg = "⚠️ Sorry, I ran into an error generating your nutrition summary. Please try again in a moment!\n\n⚠️ *Note: Nutritional estimates are AI-generated and may have inaccuracies.*";
          await sendProactiveWhatsAppMessage(From, errMsg, undefined, AccountSid);
        }
      })();
      return;
    }

    // Check if the user is explicitly joining, rejoining, or asking for help/welcome
    const isWelcomeRequest =
      bodyText.startsWith('join') ||
      bodyText.startsWith('rejoin') ||
      bodyText === 'hi' ||
      bodyText === 'hello' ||
      bodyText === 'start' ||
      bodyText === 'help' ||
      bodyText === 'welcome' ||
      bodyText === 'begin';

    if (isWelcomeRequest) {
      const promptMsg =
        `📸 *Welcome to Food Tracker!* 🍳

I am your personal AI health coach! Send me photos of your meals to track your nutrition instantly.

⚡ *My Superpowers:*
• 📸 **Snap & Analyze**: Send a photo of your food/drink to get an instant, completely honest nutrition coach summary of what you just ate!
• 🖼️ **Multi-Image Support**: Select up to 10 photos in a single message (e.g. main dish, side, and drink) to analyze them together as one unified meal!
• 📊 **On-Demand Digests**: Send the text *"summary"* to generate a completely honest macro and calorie coaching summary of everything you have logged today!
• 🔔 **Daily Proactive Digests**: I will automatically compile and text you a personalized progress report **every evening as an end-of-day update**!
• 🔥 **Habit Streaks**: Build healthy logging habits! Every time you log a meal, you stack your streak. Log daily to keep your streak alive!
• 💬 **Ask Me Anything**: Ask me questions about your history anytime! (e.g., *"when did I last eat grapes?"* or *"how often do I eat walnuts in a week?"*)

🔕 *Control Settings:*
• To opt out of daily summaries, text *"opt out"* or *"stop summary"*.
• To reactivate daily summaries, text *"opt in"* or *"subscribe"*.

To get started, simply send me a photo of your next meal! 🥗

⚠️ *Note: Nutritional estimates are AI-generated and may have inaccuracies. Use for general tracking only.*`;

      return res.status(200).send(createTwiMLReply(promptMsg));
    }

    // Treat unknown/general text as a natural language query about their logs
    // 1. Reply to Twilio instantly to prevent timeout
    res.status(200).send(createTwiMLReply("⏳ *Looking up your food logs...* Let me check that for you! 🔍"));

    // 2. Process in background
    (async () => {
      try {
        console.log(`[Webhook Server] Query Request: Fetching logs for user tab to answer: "${Body}"...`);
        const answer = await callMcpTool("query_history", { phone: cleanedSender, profileName, query: Body });
        await sendProactiveWhatsAppMessage(From, answer, undefined, AccountSid);
      } catch (err: any) {
        console.error('[Webhook Server] Error answering user log query in background:', err);
        const errStr = (err.message || '') + ' ' + (err.status || '') + ' ' + JSON.stringify(err);
        const isRateLimit = errStr.includes('429') ||
          errStr.toLowerCase().includes('resource_exhausted') ||
          errStr.toLowerCase().includes('resource exhausted') ||
          errStr.toLowerCase().includes('quota exceeded');

        if (isRateLimit) {
          const limitMsg = "⚠️ *Slow down!* 🏃‍♂️ The AI coach is currently catching its breath. Give me a minute and ask your question again! 🧘‍♂️";
          await sendProactiveWhatsAppMessage(From, limitMsg, undefined, AccountSid);
          return;
        }

        const errMsg = "⚠️ Sorry, I ran into an error looking up your request. Please try again in a moment!";
        await sendProactiveWhatsAppMessage(From, errMsg, undefined, AccountSid);
      }
    })();
    return;
  }

  // Case 2: Media is present. Run the pipeline.
  // 1. Reply to Twilio instantly to prevent timeout
  res.status(200).send(createTwiMLReply("📸 *Got your photo!* Analyzing ingredients and logging macros... 🍳"));

  // 2. Run the heavy pipeline in the background
  (async () => {
    try {
      const imageInputs: { base64: string; mimeType: string }[] = [];

      console.log(`[Webhook Server] Processing and downloading ${numMediaCount} attachment(s)...`);

      for (let i = 0; i < numMediaCount; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const twilioMimeType = req.body[`MediaContentType${i}`];

        if (mediaUrl) {
          console.log(`[Webhook Server] Downloading media [${i}] from: ${mediaUrl}`);
          const { buffer, mimeType } = await downloadTwilioMedia(mediaUrl, AccountSid);
          const activeMime = mimeType || twilioMimeType || 'image/jpeg';

          imageInputs.push({
            base64: buffer.toString('base64'),
            mimeType: activeMime
          });
        }
      }

      if (imageInputs.length === 0) {
        const noImageMsg = "⚠️ I was unable to download your images. Please try sending them again! 📸";
        await sendProactiveWhatsAppMessage(From, noImageMsg, undefined, AccountSid);
        return;
      }

      console.log('[Webhook Server] Sending food images to Gemini via MCP Server for unified analysis...');
      const replyBody = await callMcpTool("log_food_item", {
        phone: cleanedSender,
        profileName,
        images: imageInputs,
        caption: Body
      });

      // Send response to the user first
      await sendProactiveWhatsAppMessage(From, replyBody, undefined, AccountSid);

    } catch (error: any) {
      console.error('[Webhook Server] Error during async webhook pipeline processing:', error);

      const errStr = (error.message || '') + ' ' + (error.status || '') + ' ' + JSON.stringify(error);
      const isRateLimit = errStr.includes('429') ||
        errStr.toLowerCase().includes('resource_exhausted') ||
        errStr.toLowerCase().includes('resource exhausted') ||
        errStr.toLowerCase().includes('quota exceeded');

      if (isRateLimit) {
        const funnyMsg = "⚠️ *Whoa, slow down!* 🛑 Gemini is suffering from brain freeze from analyzing too much delicious food. 🧠🍦 Give me a minute to thaw out and try sending your photo again! 📸";
        await sendProactiveWhatsAppMessage(From, funnyMsg, undefined, AccountSid);
        return;
      }

      const errorMsg =
        "⚠️ Sorry, I encountered an issue analyzing your image or saving it to the sheet. Please make sure your APIs are configured correctly and try again! 🛠️";

      await sendProactiveWhatsAppMessage(From, errorMsg, undefined, AccountSid);
    }
  })();
});

let isDailySummaryJobRunning = false;

/**
 * Automatically checks all active accounts, computes their current local time based on their timezone,
 * and if it is 9:00 PM local time and they haven't received a summary for their current local day,
 * compiles a daily digest and proactively texts it to them via WhatsApp.
 */
async function runDailyAutoSummaryJob(): Promise<void> {
  if (isDailySummaryJobRunning) {
    console.log('[Scheduler] Daily summary job is already running. Skipping execution to prevent overlap.');
    return;
  }

  isDailySummaryJobRunning = true;
  console.log('[Scheduler] Executing timezone-aware auto-summary check...');
  try {
    const activeTabs = await getAllUserTabs();
    const settingsMap = await getUserSettingsMap();
    console.log(`[Scheduler] Checking ${activeTabs.length} active account tab(s) against registered settings.`);

    for (const tab of activeTabs) {
      const tabTitle = tab.title; // e.g. "Sarang : +14082300841"
      const titleParts = tabTitle.split(' : ');
      const firstName = titleParts[0];
      const phone = titleParts[1];

      if (!phone) {
        console.warn(`[Scheduler] Skipping malformed tab name: "${tabTitle}"`);
        continue;
      }

      // 1. Retrieve the settings for this user. Fall back to standard defaults if they haven't set them yet.
      const cleanPhone = phone.replace(/[^\d]/g, '');
      const userSettings = settingsMap.get(cleanPhone) || {
        phone,
        status: 'Active' as const,
        lastUpdated: '',
        timezone: guessTimezoneFromPhone(phone),
        lastAutoSummaryDate: '',
        lastInactivityCheck: '',
        lastLogDate: '',
      };

      // 2. Check if they have opted out
      if (userSettings.status === 'Opted Out') {
        console.log(`[Scheduler] Skipping opted-out user ${firstName} (${phone}).`);
        continue;
      }

      const userTimezone = userSettings.timezone;

      // 3. Calculate current local date/time in the user's timezone
      const now = new Date();
      let localHour = 0;
      let localMinute = 0;
      let localDateStr = '';

      try {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: userTimezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });

        const parts = formatter.formatToParts(now);
        const hourPart = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        localHour = hourPart ? parseInt(hourPart.value, 10) : 0;
        localMinute = minutePart ? parseInt(minutePart.value, 10) : 0;

        // Formats local date as MM/DD/YYYY in their local timezone
        localDateStr = now.toLocaleDateString('en-US', { timeZone: userTimezone });
      } catch (tzErr) {
        console.error(`[Scheduler] Invalid timezone "${userTimezone}" for user ${phone}, falling back to America/Los_Angeles`);
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const parts = formatter.formatToParts(now);
        localHour = parts.find(p => p.type === 'hour') ? parseInt(parts.find(p => p.type === 'hour')!.value, 10) : 0;
        localMinute = parts.find(p => p.type === 'minute') ? parseInt(parts.find(p => p.type === 'minute')!.value, 10) : 0;
        localDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
      }

      // Check if we need to evaluate daily summary OR inactivity reminder
      const isDailySummaryDue = (localHour === 21 && userSettings.lastAutoSummaryDate !== localDateStr);

      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      let lastLogTime = 0;

      if (userSettings.lastLogDate) {
        const parsedTime = new Date(userSettings.lastLogDate).getTime();
        if (!isNaN(parsedTime)) {
          lastLogTime = parsedTime;
        }
      }

      // Check if inactivity check is potentially due based on Settings metadata
      const isInactivityDuePotential = lastLogTime === 0 || (Date.now() - lastLogTime) > twentyFourHoursMs;

      // 4. Trigger daily summary only at 9:00 PM (hour 21) local time, and only if it hasn't run for their current local date
      if (isDailySummaryDue) {
        console.log(`[Scheduler] Triggering daily summary for ${firstName} (${phone}). Timezone: ${userTimezone}. Current local time: 9:${localMinute.toString().padStart(2, '0')} PM.`);

        try {
          const responseObj = await callMcpToolDetailed("get_daily_summary", {
            phone,
            profileName: firstName,
            dateString: localDateStr,
            allowFallbackDays: 3
          });

          const summaryText = responseObj.content?.[0]?.text || '';

          // Check if the result was a message indicating empty logs
          if (summaryText.includes('❌') || summaryText.includes('🔍')) {
            console.log(`[Scheduler] No logged items found today for ${firstName}. Skipping proactive summary.`);
            await updateLastAutoSummaryDate(phone, localDateStr);
          } else {
            const personalizedReport = `🔔 *DAILY HEALTH COACH REPORT* 🔔\n\nHey ${firstName}, here is your daily nutrition coaching digest for today! Keep up the great work:\n\n${summaryText}\n\n🔕 _To stop receiving these daily reports, reply "opt out"_`;
            await sendProactiveWhatsAppMessage(phone, personalizedReport);
            await updateLastAutoSummaryDate(phone, localDateStr);
          }
        } catch (sumErr) {
          console.error(`[Scheduler] Failed daily summary tool call for ${firstName}:`, sumErr);
        }
      }

      // 5. Inactivity Check (Runs independently of timezone hour, throttled to max once per 24h)
      if (isInactivityDuePotential) {
        try {
          let shouldSendInactivityInspiration = false;
          if (!userSettings.lastInactivityCheck) {
            shouldSendInactivityInspiration = true;
          } else {
            const lastCheckTime = new Date(userSettings.lastInactivityCheck).getTime();
            if (isNaN(lastCheckTime) || (Date.now() - lastCheckTime) > twentyFourHoursMs) {
              shouldSendInactivityInspiration = true;
            }
          }

          if (shouldSendInactivityInspiration) {
            console.log(`[Scheduler] User ${firstName} (${phone}) has been inactive for > 24h. Generating inspiration...`);
            const inspirationMsg = await callMcpTool("get_inactivity_inspiration", {
              phone,
              profileName: firstName
            });

            if (inspirationMsg && inspirationMsg !== "No logs available.") {
              await sendProactiveWhatsAppMessage(phone, inspirationMsg);
              const currentTimestampStr = new Date().toLocaleString('en-US', { timeZoneName: 'short' });
              await updateLastInactivityCheck(phone, currentTimestampStr);
            }
          }
        } catch (inactErr) {
          console.error(`[Scheduler] Error running inactivity check for ${firstName} (${phone}):`, inactErr);
        }
      }
    }
    console.log('[Scheduler] Timezone-aware auto-summary check completed successfully.');
  } catch (error) {
    console.error('[Scheduler] Error running daily auto-summary job:', error);
  } finally {
    isDailySummaryJobRunning = false;
  }
}

// Start the server and MCP connection
async function startServer() {
  // Start the connection loop in the background so that Express can listen immediately
  initMcpClientWithRetry(60, 5000).catch(err => {
    console.error('[Webhook Server] Initial background connection to MCP Server failed:', err.message || err);
  });

  app.listen(PORT, () => {
    console.log(`🚀 Server is listening on port ${PORT}`);
    console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
  });
}

startServer();

// Check every 5 minutes to see if any user timezone has crossed the 9:00 PM local threshold
setInterval(async () => {
  try {
    await runDailyAutoSummaryJob();
  } catch (err) {
    console.error('[Scheduler] Error in daily scheduler check:', err);
  }
}, 5 * 60 * 1000);
