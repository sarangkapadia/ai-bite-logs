import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { retryWithBackoff } from '../utils/retry';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
];

export interface USDASearchCandidate {
  description: string;
  fdcId: number;
  dataType: string;
}

/**
 * Uses Gemini to reason over top search results from the USDA FoodData Central database
 * and select the best, most mathematically standard matched ingredient.
 */
export async function matchIngredientWithLLM(
  query: string,
  candidates: USDASearchCandidate[]
): Promise<number | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].fdcId;

  const prompt = `
    You are an expert nutritional data analyst.
    We are looking up standard ingredients from the USDA FoodData Central database to map meal logs to their precise nutritional profiles.
    
    Target Search Query: "${query}"
    
    Here are the top candidates returned by the database:
    ${JSON.stringify(
      candidates.map((c, index) => ({
        index: index,
        description: c.description,
        fdcId: c.fdcId,
        dataType: c.dataType,
      })),
      null,
      2
    )}
    
    Instructions:
    1. Select the index of the candidate that represents the closest, most standard, and most raw/pure form of the target ingredient query.
    2. Crucially avoid compound mixtures, dressings, seasonings, croutons, or side dishes unless the target search query explicitly calls for them (e.g. if the query is "avocado", choose plain raw avocado instead of "avocado salad dressing" or "avocado oil").
    3. Return your decision in JSON format containing a single property: "bestIndex" (an integer pointing to the index of the chosen candidate). If absolutely no candidates match, return -1.
  `;

  const operation = async () => {
    const response = await ai.models.generateContent({
      model: TEXT_MODELS[0],
      contents: prompt,
      config: {
        temperature: 0.0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            bestIndex: { type: Type.INTEGER },
          },
          required: ['bestIndex'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error('LLM Matcher returned empty response');
    }

    const res = JSON.parse(text);
    const chosenIndex = res.bestIndex;
    if (chosenIndex !== undefined && chosenIndex >= 0 && chosenIndex < candidates.length) {
      return candidates[chosenIndex].fdcId;
    }
    return null;
  };

  try {
    return await retryWithBackoff(operation);
  } catch (error) {
    console.error('[LLM USDA Matcher Error] Fallback to direct selection:', error);
    return null;
  }
}
