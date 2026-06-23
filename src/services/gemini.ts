import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { retryWithBackoff } from '../utils/retry';

dotenv.config();

// Initialize the Google Gen AI client.
// It will automatically pick up GEMINI_API_KEY from environment variables.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface FoodIngredientInfo {
  name: string;
  usdaSearchQuery: string;
  estimatedWeightGrams: number;
  aiFallbackCalories: number;
  aiFallbackProteinGrams: number;
  aiFallbackCarbsGrams: number;
  aiFallbackFatGrams: number;
}

export interface FoodNutritionInfo {
  foodDetected: boolean;
  foodName: string;
  healthStatus: 'Healthy' | 'Moderation' | 'Unhealthy';
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  briefExplanation: string;
  suggestedEmoji: string;
  foodJoke: string;
  ingredients?: FoodIngredientInfo[];
  requiresClarification?: boolean;
  clarificationQuestions?: string[];
}

export interface FoodImageInput {
  base64: string;
  mimeType: string;
}

const VISION_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-pro-latest'
];

const TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'gemini-pro-latest'
];

/**
 * Executes a generateContent call. If a 429 / Quota Exhausted error occurs,
 * it automatically cascades down to alternate models.
 */
async function generateContentWithFallback(
  options: {
    contents: string | Array<string | Record<string, any>>;
    config?: Record<string, any>;
  },
  modelOptions: string[]
): Promise<any> {
  let lastError: any = null;

  for (const model of modelOptions) {
    try {
      console.log(`[Gemini API] Querying model: ${model}`);
      const response = await ai.models.generateContent({
        model: model,
        contents: options.contents,
        config: options.config,
      });
      return response;
    } catch (error: any) {
      lastError = error;
      const errorMsg = error.message || '';
      const errorCauseStr = error.cause ? String(error.cause.message || error.cause.code || error.cause) : '';
      const combinedErrorStr = (errorMsg + ' ' + errorCauseStr).toLowerCase();

      const isQuotaOrUnavailable =
        error.status === 429 ||
        error.status === 503 ||
        error.status === 500 ||
        errorMsg.includes('429') ||
        errorMsg.includes('503') ||
        errorMsg.includes('500') ||
        combinedErrorStr.includes('resource has been exhausted') ||
        combinedErrorStr.includes('quota exceeded') ||
        combinedErrorStr.includes('unavailable') ||
        combinedErrorStr.includes('high demand') ||
        combinedErrorStr.includes('busy') ||
        combinedErrorStr.includes('fetch failed') ||
        combinedErrorStr.includes('socket') ||
        combinedErrorStr.includes('network') ||
        combinedErrorStr.includes('econnreset') ||
        combinedErrorStr.includes('und_err_socket') ||
        combinedErrorStr.includes('closed');

      if (isQuotaOrUnavailable) {
        console.warn(`[Gemini Error] "${model}" failed (Status: ${error.status || 'unknown'}, Msg: ${errorMsg}). Cascading to next fallback model...`);
        continue;
      }

      // If it is a different error (like invalid API key), fail immediately
      throw error;
    }
  }

  throw lastError;
}

/**
 * Analyzes multiple food images simultaneously using Gemini and returns structured nutrition information.
 * Cascades across models to handle free quota limits.
 * Uses exponential backoff to handle transient network rates.
 * 
 * @param images Array of base64-encoded image strings with their respective MIME types.
 * @param userCaption Optional caption or message text sent along with the image (e.g. portion size context).
 */
export async function analyzeFoodImage(
  images: FoodImageInput[],
  userCaption?: string
): Promise<FoodNutritionInfo> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not defined.');
  }

  if (images.length === 0) {
    throw new Error('At least one image must be provided for food analysis.');
  }

  const contentsList: Array<string | Record<string, any>> = [];

  for (const img of images) {
    contentsList.push({
      inlineData: {
        data: img.base64,
        mimeType: img.mimeType,
      },
    });
  }

  // Step 1: Pre-process with Google Search Grounding to detect packaging/branded product weights.
  let searchGroundingResult = 'No commercial branding detected.';
  try {
    const searchPrompt = `
      Analyze the provided food image(s). If there are any packaged, commercial, or branded food/drink items (e.g., Almond Joy candy bar, Coca-Cola can, Reese's cups, branded snacks, restaurant chain food), use Google Search to find their standard commercial weights or standard portion sizes in grams.
      Return a brief, bulleted summary of standard sizes and weights found.
      If there are no commercial/branded items or it is a home-cooked unbranded meal, simply reply: "No commercial branding detected."
    `;

    const searchContents = [...contentsList, searchPrompt];

    const searchResponse = await generateContentWithFallback({
      contents: searchContents,
      config: {
        tools: [{ googleSearch: {} }]
      }
    }, VISION_MODELS);

    if (searchResponse.text && !searchResponse.text.includes('No commercial branding detected')) {
      searchGroundingResult = searchResponse.text;
      console.log('[Gemini API] Google Search Sizing Grounding Context obtained:\n', searchGroundingResult);
    }
  } catch (err) {
    console.error('[Gemini API] Failed running Google Search Sizing Grounding (skipping to default estimation):', err);
  }

  const prompt = `
    Analyze the provided image(s) to see if they contain any food or drink.
    If multiple images are provided, treat them as parts of a single, unified meal (e.g. main dish in image 1, side dish in image 2, beverage in image 3).
    
    CRITICAL: The user has attached additional caption context/metadata along with the photo. You MUST take this into account when estimating ingredients, sizes, portions, or customization (e.g., if they say "only ate half", "sugar-free", "double protein", "oat milk instead of whole milk").
    User Attached Context: "${userCaption || 'None'}"

    CRITICAL SIZING RULE: Pay close attention to standard commercial packaging size indicators in the image (e.g., "Fun Size", "Miniature", "Single Serving", "Share Size") and cross-reference them with the provided Google Search Sizing Context. If a commercial branded item is detected, use the weights from the Search Sizing Context that best fit the visual scale of the product in the image.
    Google Search Sizing Context: "${searchGroundingResult}"
    
    1. Determine if food/drink is present:
       - Set 'foodDetected' to true if food or beverage is visible in any of the images or described in the context.
       - Set 'foodDetected' to false if no food or beverage is visible in any of the images and none is mentioned.
       
    2. If food/drink IS present (foodDetected is true):
       - foodName: What is the food called? Combine items if multiple exist (Be descriptive but concise, e.g. "Cheeseburger with French Fries and Diet Coke")
       - healthStatus: Is it healthy, okay in moderation, or generally unhealthy? Choose exactly one: 'Healthy', 'Moderation', or 'Unhealthy'.
       - ingredients: A detailed array containing each constituent ingredient/food/beverage component in the meal. For each ingredient:
         * name: The descriptive name of the ingredient (e.g. "grilled chicken breast")
         * usdaSearchQuery: A database-optimized search query for USDA FoodData Central (e.g., "chicken breast cooked" instead of descriptive names, "white rice cooked" instead of "steamed jasmine rice", "olive oil" instead of "drizzled extra virgin olive oil").
         * estimatedWeightGrams: Your best estimation of the weight of this ingredient in grams (or milliliters for liquids).
         * aiFallbackCalories: Your estimation of total calories for this ingredient weight.
         * aiFallbackProteinGrams: Your estimation of protein in grams.
         * aiFallbackCarbsGrams: Your estimation of carbs in grams.
         * aiFallbackFatGrams: Your estimation of fat in grams.
       - calories: Sum of all ingredients' fallback calories.
       - proteinGrams: Sum of all ingredients' fallback protein.
       - carbsGrams: Sum of all ingredients' fallback carbs.
       - fatGrams: Sum of all ingredients' fallback fat.
       - briefExplanation: A 1-2 sentence explanation of the nutritional value of the whole meal and why it is categorized as Healthy, Moderation, or Unhealthy. Make sure to reference the user's specific context if it influenced the estimation (e.g., portion reduction).
       - suggestedEmoji: Select a single emoji that represents the contextual theme of the meal/beverage. Follow these rules:
          * Use 💪 if the meal is high in protein (e.g., eggs, protein shake, steak, chicken, fish).
          * Use ❤️ or 🥗 if the meal is highly healthy or clean (e.g., green salad, fruit bowl, veggies).
          * Use 🤤, 🍰, 🍩, or 🍪 if the meal is a dessert, sweet treat, cheat meal, or yummy indulgence.
          * Use ☕ or 🍵 if it is coffee, tea, or a morning hot beverage.
          * Otherwise, use a standard representing food/drink emoji (like 🍕, 🍔, 🌮, 🍳, 🥤) that fits the category.
       - foodJoke: A short, funny, and clean food-related joke or pun. Make it highly contextual or relevant to the specific food items identified (e.g., if spaghetti or pasta, use a noodle pun like 'What do you call a fake noodle? An impasta!'). Keep it short (Q&A format or single line).
       - requiresClarification: Boolean. Set to true if there is moderate ambiguity or uncertainty about the specific ingredients, preparation method, or portion sizes in the image (e.g., you can see it is a curry, but you are not sure if it is chicken or tofu; or you cannot determine the portion size/weight accurately). Set to false if you are highly confident in the ingredients and portion estimation. CRITICAL: Only set to true if you are reasonably certain it is food (so uncertainty is below a threshold), but you need help with specific details/ambiguities.
       - clarificationQuestions: An array of 1 to 3 highly contextual, brief clarification questions to ask the user (e.g., "Is that chicken or tofu?", "Was it cooked in butter or olive oil?"). Only populate this array if requiresClarification is true.
       
    3. If food/drink IS NOT present (foodDetected is false):
       - Set foodName to "N/A"
       - Set healthStatus to "Unhealthy"
       - Set calories, proteinGrams, carbsGrams, fatGrams to 0
       - Set ingredients to an empty array []
       - Set briefExplanation to "No food detected in image."
       - Set suggestedEmoji to "🔍"
       - Set foodJoke to "Why did the tomato blush? Because it saw the salad dressing!"
       - Set requiresClarification to false
       - Set clarificationQuestions to []
  `;

  const finalContentsList = [...contentsList, prompt];


  const operation = async () => {
    const response = await generateContentWithFallback({
      contents: finalContentsList,
      config: {
        temperature: 0.0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            foodDetected: { type: 'BOOLEAN' },
            foodName: { type: 'STRING' },
            healthStatus: {
              type: 'STRING',
              enum: ['Healthy', 'Moderation', 'Unhealthy']
            },
            calories: { type: 'INTEGER' },
            proteinGrams: { type: 'INTEGER' },
            carbsGrams: { type: 'INTEGER' },
            fatGrams: { type: 'INTEGER' },
            briefExplanation: { type: 'STRING' },
            suggestedEmoji: { type: 'STRING' },
            foodJoke: { type: 'STRING' },
            requiresClarification: { type: 'BOOLEAN' },
            clarificationQuestions: {
              type: 'ARRAY',
              description: 'List of 1 to 3 clarification questions if requiresClarification is true.',
              items: { type: 'STRING' }
            },
            ingredients: {
              type: 'ARRAY',
              description: 'List of individual food ingredients detected.',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  usdaSearchQuery: { type: 'STRING' },
                  estimatedWeightGrams: { type: 'INTEGER' },
                  aiFallbackCalories: { type: 'INTEGER' },
                  aiFallbackProteinGrams: { type: 'INTEGER' },
                  aiFallbackCarbsGrams: { type: 'INTEGER' },
                  aiFallbackFatGrams: { type: 'INTEGER' },
                },
                required: [
                  'name',
                  'usdaSearchQuery',
                  'estimatedWeightGrams',
                  'aiFallbackCalories',
                  'aiFallbackProteinGrams',
                  'aiFallbackCarbsGrams',
                  'aiFallbackFatGrams'
                ]
              }
            }
          },
          required: [
            'foodDetected',
            'foodName',
            'healthStatus',
            'calories',
            'proteinGrams',
            'carbsGrams',
            'fatGrams',
            'briefExplanation',
            'suggestedEmoji',
            'foodJoke',
            'ingredients',
            'requiresClarification',
            'clarificationQuestions'
          ],
        },
      },
    }, VISION_MODELS);

    const text = response.text;
    if (!text) {
      throw new Error('Gemini API returned an empty response.');
    }

    return JSON.parse(text) as FoodNutritionInfo;
  };

  return retryWithBackoff(operation);
}

export interface SummaryFoodLogRow {
  timestamp: string;
  foodName: string;
  healthStatus: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  briefExplanation: string;
}

/**
 * Generates a beautiful WhatsApp-formatted nutrition coach summary report using Gemini.
 * Cascades across models to handle free quota limits.
 * 
 * @param logs Array of food log entries.
 * @param days The number of days the summary covers.
 */
export async function generateNutritionSummary(
  logs: SummaryFoodLogRow[],
  days: number,
  dateString?: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not defined.');
  }

  // Calculate Calorie-Weighted Health Score on the fly
  let totalCalories = 0;
  let weightedScoreSum = 0;

  for (const log of logs) {
    const calories = log.calories || 0;
    let score = 60; // Moderation
    if (log.healthStatus === 'Healthy') score = 100;
    else if (log.healthStatus === 'Unhealthy') score = 20;

    totalCalories += calories;
    weightedScoreSum += calories * score;
  }

  const healthScore = totalCalories > 0 ? Math.round(weightedScoreSum / totalCalories) : 100;

  const prompt = `
    You are an expert, highly precise, and completely honest nutrition coach.
    Below is a list of food and drink logs recorded by a user for ${dateString ? (days > 1 ? 'the last ' + days + ' days (' + dateString + ')' : 'today (' + dateString + ')') : 'the last ' + days + ' days'}.
    
    Food Logs:
    ${JSON.stringify(logs, null, 2)}
    
    Create a highly precise, concise, and completely honest summary report in standard WhatsApp markdown format (use emojis, bold text, and clean spacing). Do not sugarcoat critiques—be completely objective, realistic, and constructive about the healthiness of their food choices.
    
    Structure the report exactly like this:
    
    📊 *${days > 1 ? days + '-Day' : 'Daily'} Nutrition Summary*
    *${dateString ? dateString.toUpperCase() : 'TODAY'}*
    ⭐ *Health Score:* ${healthScore}/100
    
    🔥 *Calories:*
    • Total: [Total kcal]
    [Insert a 10-block emoji progress bar representing total calories against a 2000 kcal target, using the fire emoji (🔥) for progress. Do NOT surround the bar with square brackets. E.g. 🔥🔥🔥 30%]
    
    🥩 *Macros (Total):*
    • Protein: [Total P]g
      [Insert a progress bar of green emoji blocks where 1 block = 20g of protein, with no upper limit/target. Do NOT surround the bar with square brackets. E.g. 🟩🟩🟩🟩🟩 for 50g]
    • Carbs: [Total C]g
      [Insert a progress bar of yellow emoji blocks where 1 block = 30g of carbs, with no upper limit/target. Do NOT surround the bar with square brackets. E.g. 🟨🟨🟨 for 90g]
    • Fat: [Total F]g
      [Insert a progress bar of red emoji blocks where 1 block = 20g of fat, with no upper limit/target. Do NOT surround the bar with square brackets. E.g. 🟥🟥🟥 for 30g]
    
    🥗 *Food Distribution:*
    • 🟢 Healthy: [Count] 
    • 🟡 Moderation: [Count] 
    • 🔴 Unhealthy: [Count]
    
    🏆 *Top Wins:*
    [1-2 bullet points highlighting specific healthy choices, keeping them extremely brief and precise]
    
    💡 *Coach's Corner:*
    [Provide 1 precise, completely honest, and highly actionable recommendation. IMPORTANT: Refer to the modern food pyramid as a "bar" (e.g., "To balance your progress bar...", or "To fill your daily food components bar...") when giving this advice.]
    
    ⚠️ *Note: Nutritional estimates are AI-generated and may have inaccuracies. Use for general tracking only.*
  `;

  const operation = async () => {
    const response = await generateContentWithFallback({
      contents: prompt,
    }, TEXT_MODELS);

    const text = response.text;
    if (!text) {
      throw new Error('Gemini API returned an empty summary response.');
    }

    return text;
  };

  return retryWithBackoff(operation);
}

/**
 * Answers a user's natural language question about their food logs.
 *
 * @param logs The complete array of food logs for the user.
 * @param query The natural language query/question asked by the user.
 */
export async function answerUserQuery(
  logs: SummaryFoodLogRow[],
  query: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not defined.');
  }

  const prompt = `
    You are an expert, friendly, and honest personal health coach.
    The user is asking a question about their food and drink log history.
    
    Here is the complete history of their logged meals (in JSON format):
    ${JSON.stringify(logs, null, 2)}
    
    User's Question: "${query}"
    
    Instructions:
    1. Answer the user's question precisely, truthfully, and directly based on the provided logs.
    2. Format the response beautifully for WhatsApp using markdown (use bold text, clean spacing, and bullet points where appropriate).
    3. Use positive and encouraging health coach tone, but do not sugarcoat if they ask about unhealthy habits.
    4. If the query asks about a food item/event that is NOT in the logs (e.g. "when did I last eat walnuts?" but walnuts have never been logged):
       - Politely explain that you couldn't find any record of that item/event in their logs.
       - Encourage them to log it next time they eat it.
    5. If the question is completely unrelated to food tracking, health coaching, or nutrition:
       - Politely state that you can only help answer questions regarding their nutrition history and health goals.
    6. CRITICAL: The entire generated response must be extremely concise and strictly UNDER 1200 characters to prevent Twilio WhatsApp character limits from throwing errors.
  `;

  const operation = async () => {
    const response = await generateContentWithFallback({
      contents: prompt,
    }, TEXT_MODELS);

    const text = response.text;
    if (!text) {
      throw new Error('Gemini API returned an empty query response.');
    }

    return text;
  };

  return retryWithBackoff(operation);
}

/**
 * Generates a contextual, snappy, and encouraging reminder referencing the user's past logging history,
 * asking them to come back and log their meals.
 * The message will end with:
 * "(To stop receiving these reminders, reply 'opt out')"
 *
 * @param logs The complete array of food logs for the user.
 */
export async function generateInactivityInspiration(
  logs: SummaryFoodLogRow[]
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not defined.');
  }

  const prompt = `
    You are an expert personal health coach.
    A user has had no interactions with the app (logged zero meals/drinks) in the last 24 hours.
    Here is the history of their logged meals before this inactive period (in JSON format):
    ${JSON.stringify(logs, null, 2)}

    Write a super contextual, snappy, and encouraging reminder message asking them to come back and log their next meal or drink.
    Follow these instructions:
    1. The reminder MUST start with a fascinating food trivia fact or quick quiz question directly related to one of their favorite logged ingredients or meal themes from their history (e.g. if they logged almonds often, share an almond fact; if green tea, share a green tea fact).
    2. Reference details from their past logs (e.g. salads, wins, favorite foods, or general trend) to make the connection highly personalized and relevant.
    3. Keep the tone warm, coaching, motivational, and snappy.
    4. Keep it brief (2-4 sentences max).
    5. Format the response for WhatsApp using markdown (bolding, emojis, clean spacing).
    6. CRITICAL: You MUST explicitly append the following exact opt-out message at the very end of your response as a new paragraph:
       🔕 _To stop receiving these reminders, reply "opt out"_
  `;

  const operation = async () => {
    const response = await generateContentWithFallback({
      contents: prompt,
    }, TEXT_MODELS);

    const text = response.text;
    if (!text) {
      throw new Error('Gemini API returned an empty inactivity response.');
    }

    return text;
  };

  return retryWithBackoff(operation);
}
