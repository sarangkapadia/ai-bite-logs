import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function check() {
  try {
    const list = await (ai.models as any).list();
    const items = [];
    
    // The new SDK Pager supports for await...of loop for pagination
    for await (const model of list) {
      items.push(model);
    }
    
    const geminiModels = items
      .filter((m: any) => m.name.includes('gemini') && m.supportedActions.includes('generateContent'))
      .map((m: any) => ({
        name: m.name,
        displayName: m.displayName
      }));
    
    console.log('Available Gemini Models for generateContent:');
    console.log(JSON.stringify(geminiModels, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
}

check();
