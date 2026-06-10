import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

async function fetchLogs() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('Missing Twilio credentials.');
    return;
  }

  const client = twilio(accountSid, authToken);

  try {
    console.log('Fetching messaging logs from Twilio...');
    const messages = await client.messages.list({ limit: 50 });
    
    console.log('\n======================================');
    console.log(`FOUND ${messages.length} RECENT MESSAGES:`);
    console.log('======================================\n');

    messages.forEach(msg => {
      console.log(`[${msg.dateCreated.toLocaleString()}]`);
      console.log(`Direction: ${msg.direction}`);
      console.log(`From:      ${msg.from}`);
      console.log(`To:        ${msg.to}`);
      console.log(`Status:    ${msg.status}`);
      console.log(`Body:      "${msg.body}"`);
      console.log('--------------------------------------');
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
  }
}

fetchLogs();
