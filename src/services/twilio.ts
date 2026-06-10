import axios from 'axios';
import twilio from 'twilio';
import fs from 'fs';
import path from 'path';
import { getUserSettingsMap } from './sheets';

export interface TwilioAccount {
  accountSid: string;
  authToken: string;
  whatsappFrom: string;
}

/**
 * Dynamically resolves all Twilio accounts defined in the .env configuration.
 */
export function getTwilioAccounts(): TwilioAccount[] {
  const accounts: TwilioAccount[] = [];
  
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    accounts.push({
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '+14155238886'
    });
  }

  let index = 2;
  while (true) {
    const sid = process.env[`TWILIO_ACCOUNT_SID_${index}`];
    const token = process.env[`TWILIO_AUTH_TOKEN_${index}`];
    const from = process.env[`TWILIO_WHATSAPP_FROM_${index}`];
    
    if (sid && token) {
      accounts.push({
        accountSid: sid,
        authToken: token,
        whatsappFrom: from || '+14155238886'
      });
      index++;
    } else {
      break;
    }
  }

  return accounts;
}

/**
 * Tracks and increments the count of outgoing messages sent to Twilio for the current day.
 * Persists the count to a local twilio_usage.json file.
 */
export function trackOutgoingMessage(): number {
  const usageFilePath = path.resolve(__dirname, '../../twilio_usage.json');
  const todayStr = new Date().toLocaleDateString('en-US'); // e.g., "6/4/2026"
  
  let data: Record<string, number> = {};
  if (fs.existsSync(usageFilePath)) {
    try {
      data = JSON.parse(fs.readFileSync(usageFilePath, 'utf8'));
    } catch {
      data = {};
    }
  }

  const currentCount = data[todayStr] || 0;
  const newCount = currentCount + 1;
  data[todayStr] = newCount;

  try {
    fs.writeFileSync(usageFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write twilio_usage.json:', err);
  }

  console.log(`[Twilio Tracker] Outgoing messages sent today (${todayStr}): ${newCount}`);
  
  if (newCount >= 45) {
    console.warn(`[Twilio Warning] ⚠️ Approaching Twilio sandbox daily limit! Messages sent today: ${newCount}/50`);
  }
  
  return newCount;
}

/**
 * Downloads a protected media file (e.g. food image) from Twilio using HTTP Basic Auth.
 * Returns the file buffer and the content-type (MIME type).
 * 
 * @param mediaUrl The URL of the media provided in the Twilio Webhook payload.
 * @param targetAccountSid Optional Account SID to resolve credentials.
 */
export async function downloadTwilioMedia(
  mediaUrl: string,
  targetAccountSid?: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const accounts = getTwilioAccounts();
  if (accounts.length === 0) {
    throw new Error('No Twilio accounts are configured in environment variables.');
  }

  let resolvedAccount = accounts[0];
  if (targetAccountSid) {
    const match = accounts.find(acc => acc.accountSid === targetAccountSid);
    if (match) {
      resolvedAccount = match;
    }
  }

  const { accountSid, authToken } = resolvedAccount;

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials are not defined.');
  }

  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: {
        username: accountSid,
        password: authToken,
      },
    });

    const buffer = Buffer.from(response.data);
    const rawMime = response.headers['content-type'];
    const mimeType = typeof rawMime === 'string' ? rawMime : 'image/jpeg';

    return { buffer, mimeType };
  } catch (error) {
    console.error(`Failed to download Twilio media using Account SID ${accountSid}:`, error);
    throw error;
  }
}

/**
 * Generates the TwiML XML string to respond to Twilio's incoming message webhook.
 * Supports optional media attachment (e.g. daily summary charts).
 * 
 * @param textBody The text content of the reply message.
 * @param mediaUrl Optional public URL of media to attach.
 */
export function createTwiMLReply(textBody: string, mediaUrl?: string): string {
  trackOutgoingMessage();
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const response = new MessagingResponse();
  const msg = response.message(textBody);
  if (mediaUrl) {
    msg.media(mediaUrl);
  }
  return response.toString();
}

/**
 * Sends a proactive WhatsApp message to a specific number using Twilio's REST API client.
 * Supports optional media attachment and resolves the proper sandbox account by Account SID.
 * 
 * @param to The recipient's phone number (with country code, e.g. "+15551234567").
 * @param body The text message body.
 * @param mediaUrl Optional public URL of media to attach.
 * @param overrideAccountSid Optional Twilio Account SID to override account selection.
 */
export async function sendProactiveWhatsAppMessage(
  to: string,
  body: string,
  mediaUrl?: string,
  overrideAccountSid?: string
): Promise<void> {
  const accounts = getTwilioAccounts();
  if (accounts.length === 0) {
    throw new Error('No Twilio accounts are configured in environment variables.');
  }

  let selectedAccountSid = overrideAccountSid;

  if (!selectedAccountSid) {
    try {
      const cleanPhone = to.replace(/[^\d]/g, '');
      const settingsMap = await getUserSettingsMap();
      const userSettings = settingsMap.get(cleanPhone);
      if (userSettings && userSettings.twilioAccountSid) {
        selectedAccountSid = userSettings.twilioAccountSid;
      }
    } catch (err) {
      console.error(`[Twilio Service] Failed to lookup user twilioAccountSid settings for ${to}:`, err);
    }
  }

  let resolvedAccount = accounts[0];

  if (selectedAccountSid) {
    const match = accounts.find(acc => acc.accountSid === selectedAccountSid);
    if (match) {
      resolvedAccount = match;
    } else {
      console.warn(`[Twilio Service] Twilio Account SID "${selectedAccountSid}" is not configured. Falling back to default account.`);
    }
  }

  const { accountSid, authToken, whatsappFrom } = resolvedAccount;

  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const formattedFrom = whatsappFrom.startsWith('whatsapp:') ? whatsappFrom : `whatsapp:${whatsappFrom}`;

  try {
    const client = twilio(accountSid, authToken);
    const msgParams: any = {
      body: body,
      from: formattedFrom,
      to: formattedTo,
    };

    if (mediaUrl) {
      msgParams.mediaUrl = [mediaUrl];
    }

    await client.messages.create(msgParams);
    console.log(`[Twilio API] Proactive message sent to ${to} from ${formattedFrom} using Account SID ${accountSid}`);
    trackOutgoingMessage();
  } catch (error) {
    console.error(`Failed to send proactive WhatsApp message to ${to} from ${formattedFrom} using Account SID ${accountSid}:`, error);
    throw error;
  }
}
