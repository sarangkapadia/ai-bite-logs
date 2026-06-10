import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export interface USDAFoodNutrients {
  calories: number;     // per 100g
  protein: number;      // per 100g
  carbs: number;        // per 100g
  fat: number;          // per 100g
  description: string;  // matched food item description
  fdcId: number;        // FoodData Central ID
}

// Caching configuration
const CACHE_PATH = path.join(process.cwd(), 'usda-cache.json');
let cache: Record<string, USDAFoodNutrients> = {};

// Load cache from file synchronously at startup
try {
  if (fs.existsSync(CACHE_PATH)) {
    const data = fs.readFileSync(CACHE_PATH, 'utf8');
    cache = JSON.parse(data);
    console.log(`[USDA Cache] Loaded ${Object.keys(cache).length} cached entries from ${CACHE_PATH}`);
  } else {
    console.log('[USDA Cache] No existing cache file found. Starting with empty cache.');
  }
} catch (err) {
  console.error('[USDA Cache] Failed to load cache file:', err);
}

// Simple serialized write queue to prevent concurrent file writes from corrupting the JSON file
let isWriting = false;
const writeQueue: string[] = [];

async function triggerWrite() {
  if (isWriting) return;
  isWriting = true;
  try {
    const dataToWrite = JSON.stringify(cache, null, 2);
    await fs.promises.writeFile(CACHE_PATH, dataToWrite, 'utf8');
  } catch (err) {
    console.error('[USDA Cache] Error writing cache file:', err);
  } finally {
    isWriting = false;
    if (writeQueue.length > 0) {
      writeQueue.shift();
      triggerWrite();
    }
  }
}

function queueCacheWrite() {
  writeQueue.push('write');
  triggerWrite();
}

/**
 * Queries USDA FoodData Central search endpoint to look up nutritional density for a given query string.
 * API Endpoint: https://api.nal.usda.gov/fdc/v1/foods/search
 * 
 * Rates/Limits: USDA DEMO_KEY is rate-limited. Fallback should be handled by the caller.
 * 
 * @param query The food name to search for (e.g. "cooked white rice")
 * @returns USDAFoodNutrients containing nutritional densities per 100g, or null if not found/error.
 */
import { matchIngredientWithLLM } from './usda-matcher';

// ... (types and documentation remain the same) ...

export async function fetchUSDANutrition(query: string): Promise<USDAFoodNutrients | null> {
  const cacheKey = query.trim().toLowerCase();
  
  // Check cache hit
  if (cache[cacheKey]) {
    console.log(`[USDA Cache] Cache HIT for: "${query}"`);
    return cache[cacheKey];
  }

  const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY';
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search';

  try {
    console.log(`[USDA API] Searching for: "${query}" using key: ${apiKey === 'DEMO_KEY' ? 'DEMO_KEY' : 'CONFIGURED_KEY'}`);
    const response = await axios.get(url, {
      params: {
        api_key: apiKey,
        query: query,
        pageSize: 25,
      },
      timeout: 10000, // 10s timeout
    });

    const foods: any[] = response.data?.foods || [];
    if (foods.length === 0) {
      console.log(`[USDA API] No results found for query: "${query}"`);
      return null;
    }

    // Try using Gemini to reason and choose the best matching standard ingredient from the top 10 candidates
    const candidates = foods.slice(0, 10).map(f => ({
      description: f.description,
      fdcId: f.fdcId,
      dataType: f.dataType,
    }));

    let food: any = null;
    const llmMatchedFdcId = await matchIngredientWithLLM(query, candidates);
    
    if (llmMatchedFdcId !== null) {
      food = foods.find(f => f.fdcId === llmMatchedFdcId);
    }

    // Fallback if LLM match fails or returns null
    if (!food) {
      const preferredTypes = ['Survey (FNDDS)', 'Foundation', 'SR Legacy'];
      food = foods.find(f => preferredTypes.includes(f.dataType));
    }

    if (!food) {
      food = foods[0];
    }

    console.log(`[USDA API] Match chosen for query "${query}": "${food.description}" (ID: ${food.fdcId}, Type: ${food.dataType})`);
    const nutrients = food.foodNutrients || [];

    // Parse nutrients. FDC nutrient IDs:
    // Energy (KCAL) - 1008
    // Protein (G) - 1003
    // Carbohydrate (G) - 1005
    // Total lipid (fat) (G) - 1004
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;

    for (const n of nutrients) {
      const nutrientId = Number(n.nutrientId);
      const value = Number(n.value) || 0;

      if (
        nutrientId === 1008 ||
        nutrientId === 2047 ||
        nutrientId === 2048 ||
        n.nutrientName?.toLowerCase().includes('energy') ||
        n.unitName?.toLowerCase() === 'kcal'
      ) {
        calories = value;
      } else if (nutrientId === 1003 || n.nutrientName?.toLowerCase() === 'protein') {
        protein = value;
      } else if (nutrientId === 1005 || n.nutrientName?.toLowerCase().includes('carbohydrate')) {
        carbs = value;
      } else if (nutrientId === 1004 || n.nutrientName?.toLowerCase().includes('total lipid') || n.nutrientName?.toLowerCase() === 'fat') {
        fat = value;
      }
    }

    const result = {
      calories,
      protein,
      carbs,
      fat,
      description: food.description,
      fdcId: food.fdcId,
    };

    cache[cacheKey] = result;
    queueCacheWrite();

    return result;
  } catch (error: any) {
    console.error(`[USDA API Error] Failed searching query "${query}":`, error.message || error);
    return null;
  }
}
