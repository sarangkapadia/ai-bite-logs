import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { analyzeFoodImage } from '../services/gemini';
import { appendFoodLogToSheets } from '../services/sheets';

dotenv.config();

/**
 * A simple red 1x1 PNG pixel represented in Base64.
 * Used as a fallback if the user does not supply an image file.
 */
const RED_PIXEL_BASE64 = 
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  console.log('======= Local BiteCoach Verification Test =======');

  const args = process.argv.slice(2);
  const targetImagePath = args[0];

  let base64Data = '';
  let mimeType = 'image/png';

  if (targetImagePath) {
    const fullPath = path.resolve(targetImagePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Error: The specified file does not exist at "${fullPath}"`);
      process.exit(1);
    }
    
    console.log(`Reading custom food image from: ${fullPath}`);
    const fileBuffer = fs.readFileSync(fullPath);
    base64Data = fileBuffer.toString('base64');
    
    // Extract mime type based on file extension
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    }
  } else {
    console.log('No local image file was provided.');
    console.log('Using a mock 1x1 red pixel image for test fallback.');
    console.log('💡 Note: You can run: npm run test-local <path-to-real-food-image> for accurate nutrition analysis.');
    base64Data = RED_PIXEL_BASE64;
  }

  try {
    // 1. Verify Gemini API Key configuration
    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️ Warning: GEMINI_API_KEY is not defined in your .env file.');
      console.log('Aborting testing. Please fill in your .env credentials.');
      return;
    }

    // 2. Perform Gemini Food Analysis
    console.log('\nStep 1: Contacting Gemini API for food analysis...');
    const result = await analyzeFoodImage([{ base64: base64Data, mimeType }]);
    console.log('✅ Gemini Response Received!');
    console.log('--------------------------------------------------');
    console.log(JSON.stringify(result, null, 2));
    console.log('--------------------------------------------------');

    // 3. Verify Google Sheets configuration
    if (!process.env.GOOGLE_SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.warn('\n⚠️ Warning: Google Sheets credentials are not fully configured in your .env file.');
      console.log('Skipping step 2 (Google Sheets logging).');
      return;
    }

    // 4. Perform Google Sheets Logging
    console.log('\nStep 2: Appending log to Google Sheets...');
    await appendFoodLogToSheets(result, ['http://test-local-image.url']);
    console.log('✅ Google Sheets write completed successfully!');

    console.log('\n🎉 Verification completed successfully!');
  } catch (err) {
    console.error('\n❌ Test failed with error:', err);
  }
}

main();
