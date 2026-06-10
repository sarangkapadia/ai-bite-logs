import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function checkModels() {
  console.log('--- Listing Available Models from Google Gen AI API ---');
  try {
    const modelsResponse = await (ai.models as any).list();
    console.log('Successfully retrieved models list:');
    
    // Check if modelsResponse is iterable or has a list property
    console.log(JSON.stringify(modelsResponse, null, 2));
  } catch (error) {
    console.error('Error fetching models list:', error);
  }
}

checkModels();
