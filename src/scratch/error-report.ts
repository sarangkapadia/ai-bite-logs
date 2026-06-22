import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

async function generateErrorReport() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!spreadsheetId || !clientEmail || !privateKey) {
    console.error('❌ Error: Google Sheets environment variables are not fully configured in your .env file.');
    return;
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];

    if (!existingSheetTitles.includes('ErrorLogs')) {
      console.log('\n==================================================');
      console.log('📝 BITECOACH ERROR LOGS SUMMARY REPORT');
      console.log('==================================================');
      console.log('No error logs found (the "ErrorLogs" sheet does not exist yet).');
      console.log('This means zero errors have occurred since setup! 🎉');
      console.log('==================================================\n');
      return;
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'ErrorLogs!A2:E',
    });

    const rows = response.data.values || [];

    console.log('\n==================================================');
    console.log('📝 BITECOACH ERROR LOGS SUMMARY REPORT');
    console.log(`Total Errors Recorded: ${rows.length}`);
    console.log('==================================================\n');

    if (rows.length === 0) {
      console.log('Zero error log rows recorded in the sheet! 🎉\n');
      return;
    }

    // 1. Group by Context Type
    const contextCounts: Record<string, number> = {};
    // 2. Group by categorized Root Cause
    const causeCounts: Record<string, number> = {};
    // 3. Keep track of recent entries
    const recentErrors: Array<{ timestamp: string; phone: string; context: string; message: string }> = [];

    for (const row of rows) {
      const [timestamp, phone, context, message] = row;
      
      // Track Context
      const ctx = context || 'unknown';
      contextCounts[ctx] = (contextCounts[ctx] || 0) + 1;

      // Group Root Cause
      const msgLower = (message || '').toLowerCase();
      let category = 'Other / Unknown Error';

      if (msgLower.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted') || msgLower.includes('limit')) {
        category = 'Rate Limiting (Gemini/Twilio Quota Exceeded)';
      } else if (msgLower.includes('503') || msgLower.includes('unavailable')) {
        category = 'Temporary Service Unavailable (503)';
      } else if (msgLower.includes('500') || msgLower.includes('internal server error')) {
        category = 'Internal Server Error (500)';
      } else if (msgLower.includes('timeout') || msgLower.includes('socket') || msgLower.includes('closed') || msgLower.includes('fetch failed') || msgLower.includes('econnreset')) {
        category = 'Network Timeout / Socket Connection Drop';
      } else if (msgLower.includes('credentials') || msgLower.includes('auth') || msgLower.includes('key') || msgLower.includes('unauthorized')) {
        category = 'API Authentication / Configuration Error';
      } else if (msgLower.includes('sheets') || msgLower.includes('spreadsheet')) {
        category = 'Google Sheets Access / Write Locked Error';
      } else if (message) {
        // truncate raw messages for general category groupings
        const cleanMsg = message.length > 60 ? message.substring(0, 57) + '...' : message;
        category = `General: "${cleanMsg}"`;
      }

      causeCounts[category] = (causeCounts[category] || 0) + 1;

      recentErrors.push({ timestamp, phone, context: ctx, message: message || '' });
    }

    // Sort causes by frequency
    const sortedCauses = Object.entries(causeCounts).sort((a, b) => b[1] - a[1]);

    // Print Failures by Context
    console.log('📌 FAILURES BY TRIGGER CONTEXT:');
    Object.entries(contextCounts).forEach(([ctx, count]) => {
      console.log(`  • ${ctx.toUpperCase().padEnd(15)} : ${count} times`);
    });
    console.log();

    // Print Root Causes
    console.log('🔍 ROOT CAUSE ANALYSIS & FREQUENCY:');
    sortedCauses.forEach(([cause, count], idx) => {
      console.log(`  ${idx + 1}. [${count} occurrences] ${cause}`);
    });
    console.log();

    // Print most recent 5 errors
    console.log('🕒 MOST RECENT ERRORS:');
    const recentLimit = Math.min(5, recentErrors.length);
    for (let i = recentErrors.length - 1; i >= recentErrors.length - recentLimit; i--) {
      const err = recentErrors[i];
      console.log(`  [${err.timestamp}] User ${err.phone} (${err.context.toUpperCase()})`);
      console.log(`  👉 Msg: ${err.message.substring(0, 100)}${err.message.length > 100 ? '...' : ''}`);
      console.log('  --------------------------------------------------');
    }

  } catch (error) {
    console.error('❌ Failed to retrieve error report logs:', error);
  }
}

generateErrorReport();
