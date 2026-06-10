import express from "express";
import bodyParser from "body-parser";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  analyzeFoodImage,
  generateNutritionSummary,
  answerUserQuery,
  generateInactivityInspiration,
  FoodImageInput
} from "../services/gemini";
import {
  appendFoodLogToSheets,
  getUserLogRows,
  optOutUser
} from "../services/sheets";
import { sendProactiveWhatsAppMessage } from "../services/twilio";

import { fetchUSDANutrition } from "../services/usda";

// Initialize the MCP Server
const server = new Server(
  {
    name: "food-tracker-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools available
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "log_food_item",
        description: "Logs a food item or meal from images and captions, calculates nutrition, and appends to Google Sheets.",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "The user's clean phone number." },
            profileName: { type: "string", description: "The WhatsApp profile name of the user." },
            images: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  base64: { type: "string", description: "Base64 encoded string of the image." },
                  mimeType: { type: "string", description: "MIME type of the image." }
                },
                required: ["base64", "mimeType"]
              },
              description: "Array of images representing the meal."
            },
            caption: { type: "string", description: "Optional user caption description of portion, milk type, etc." }
          },
          required: ["phone", "profileName"]
        }
      },
      {
        name: "get_daily_summary",
        description: "Fetches user logs and generates a daily nutrition digest for today.",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "The user's clean phone number." },
            profileName: { type: "string", description: "The WhatsApp profile name of the user." },
            dateString: { type: "string", description: "Optional calendar date string (e.g. MM/DD/YYYY in user timezone)." },
            allowFallbackDays: { type: "number", description: "Number of days to check back if today has no logs (default: 1)." }
          },
          required: ["phone", "profileName"]
        }
      },
      {
        name: "query_history",
        description: "Queries the user's historical food logs to answer natural language questions about their eating habits.",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "The user's clean phone number." },
            profileName: { type: "string", description: "The WhatsApp profile name of the user." },
            query: { type: "string", description: "The natural language query question." }
          },
          required: ["phone", "profileName", "query"]
        }
      },
      {
        name: "update_settings",
        description: "Opts a user in or out of receiving daily auto summaries.",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "The user's clean phone number." },
            status: { type: "string", enum: ["opt-in", "opt-out"], description: "Whether to opt in or opt out." }
          },
          required: ["phone", "status"]
        }
      },
      {
        name: "get_inactivity_inspiration",
        description: "Generates a personalized inspiration reminder for an inactive user based on their history.",
        inputSchema: {
          type: "object",
          properties: {
            phone: { type: "string", description: "The user's clean phone number." },
            profileName: { type: "string", description: "The WhatsApp profile name of the user." }
          },
          required: ["phone", "profileName"]
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "log_food_item") {
      const { phone, profileName, images = [], caption } = args as any;
      const firstName = profileName.trim().split(/\s+/)[0];
      const tabName = `${firstName} : ${phone}`;

      if (images.length === 0) {
        return {
          content: [{ type: "text", text: "❌ No images were provided for logging. Food tracking requires an image." }],
          isError: true
        };
      }

      console.error(`[MCP Server] Analyzing food snap for user "${tabName}"...`);
      const nutritionInfo = await analyzeFoodImage(images, caption);

      if (!nutritionInfo.foodDetected) {
        return {
          content: [{ type: "text", text: "🔍 I couldn't detect any food or drink in those images. Please make sure the food is clearly visible and try sending another photo! 🍎" }]
        };
      }

      // Query USDA API for each ingredient in parallel, falling back to AI estimated values if API fails or no match is found.
      const ingredients = nutritionInfo.ingredients || [];
      let totalCalories = 0;
      let totalProtein = 0;
      let totalCarbs = 0;
      let totalFat = 0;
      let allIngredientsVerified = true;
      const ingredientDetailsList: string[] = [];

      const lookupPromises = ingredients.map(async (ingredient) => {
        const usdaResult = await fetchUSDANutrition(ingredient.usdaSearchQuery);
        let weightFactor = ingredient.estimatedWeightGrams / 100;
        let cal = 0;
        let prot = 0;
        let carb = 0;
        let fatVal = 0;
        let verified = false;

        if (usdaResult) {
          cal = Math.round(usdaResult.calories * weightFactor);
          prot = Math.round(usdaResult.protein * weightFactor * 10) / 10;
          carb = Math.round(usdaResult.carbs * weightFactor * 10) / 10;
          fatVal = Math.round(usdaResult.fat * weightFactor * 10) / 10;
          verified = true;

          console.error(
            `[MCP Server] [Calculation] Verified Ingredient: "${ingredient.name}"\n` +
            `  - USDA Match: "${usdaResult.description}" (FDC ID: ${usdaResult.fdcId})\n` +
            `  - Weight: ${ingredient.estimatedWeightGrams}g (Weight Factor: ${weightFactor})\n` +
            `  - Calories: ${usdaResult.calories} kcal/100g * ${weightFactor} = ${cal} kcal\n` +
            `  - Protein:  ${usdaResult.protein}g/100g * ${weightFactor} = ${prot}g\n` +
            `  - Carbs:    ${usdaResult.carbs}g/100g * ${weightFactor} = ${carb}g\n` +
            `  - Fat:      ${usdaResult.fat}g/100g * ${weightFactor} = ${fatVal}g`
          );
        } else {
          cal = ingredient.aiFallbackCalories;
          prot = ingredient.aiFallbackProteinGrams;
          carb = ingredient.aiFallbackCarbsGrams;
          fatVal = ingredient.aiFallbackFatGrams;

          console.error(
            `[MCP Server] [Calculation] Unverified Ingredient (AI Fallback): "${ingredient.name}"\n` +
            `  - Weight: ${ingredient.estimatedWeightGrams}g\n` +
            `  - Calories: ${cal} kcal\n` +
            `  - Protein:  ${prot}g\n` +
            `  - Carbs:    ${carb}g\n` +
            `  - Fat:      ${fatVal}g`
          );
        }

        return {
          name: ingredient.name,
          weight: ingredient.estimatedWeightGrams,
          cal,
          prot,
          carb,
          fatVal,
          verified
        };
      });

      const processedIngredients = await Promise.all(lookupPromises);

      for (const item of processedIngredients) {
        totalCalories += item.cal;
        totalProtein += item.prot;
        totalCarbs += item.carb;
        totalFat += item.fatVal;
        
        if (!item.verified) {
          allIngredientsVerified = false;
        }

        ingredientDetailsList.push(
          `• ${item.name} (${item.weight}g): ${item.cal} kcal (P: ${item.prot}g | C: ${item.carb}g | F: ${item.fatVal}g)`
        );
      }

      // Round aggregated values
      totalCalories = Math.round(totalCalories);
      totalProtein = Math.round(totalProtein * 10) / 10;
      totalCarbs = Math.round(totalCarbs * 10) / 10;
      totalFat = Math.round(totalFat * 10) / 10;

      // Update the nutritionInfo object with correct sums
      nutritionInfo.calories = totalCalories;
      nutritionInfo.proteinGrams = totalProtein;
      nutritionInfo.carbsGrams = totalCarbs;
      nutritionInfo.fatGrams = totalFat;

      // Perform Sheets log append in background asynchronously to prevent block
      appendFoodLogToSheets(nutritionInfo, undefined, tabName)
        .then(async (res) => {
          console.error(`[MCP Background Task] Appended log for ${phone}. User streak is now ${res.streakCount}`);
          const streakMsg = `🔥 *Streak:* That's ${res.streakCount} meals logged consecutively! Keep up the momentum! 💪`;
          await sendProactiveWhatsAppMessage(phone, streakMsg);
        })
        .catch(err => {
          console.error(`[MCP Background Task] Failed to append log to sheets for user "${tabName}":`, err);
        });

      let healthIndicator = "🟡 Moderation";
      if (nutritionInfo.healthStatus === "Healthy") {
        healthIndicator = "🟢 Healthy";
      } else if (nutritionInfo.healthStatus === "Unhealthy") {
        healthIndicator = "🔴 Unhealthy";
      }

      const imageNote = images.length > 1 ? `📸 _(Analyzed ${images.length} images together)_` : "";
      const emojiHeader = nutritionInfo.suggestedEmoji || "🍳";
      const attributionNotice = allIngredientsVerified
        ? "📊 *Data Source:* Verified by USDA FoodData Central"
        : "⚠️ *Data Source:* Mixed (Includes AI-estimated approximations)";

      const replyBody =
        `${emojiHeader} *Food Logged!*
${imageNote}

🥗 *Meal:* *${nutritionInfo.foodName}*
📊 *Status:* ${healthIndicator}
🔥 *Calories:* ~${nutritionInfo.calories} kcal

🥩 *Macros:*
• Protein: ${nutritionInfo.proteinGrams}g | Carbs: ${nutritionInfo.carbsGrams}g | Fat: ${nutritionInfo.fatGrams}g

🌾 *Ingredients:*
${ingredientDetailsList.join("\n")}

📝 *Coach's Note:*
_${nutritionInfo.briefExplanation}_

🎭 *Daily Bite:*
_${nutritionInfo.foodJoke}_

${attributionNotice}`;

      return {
        content: [{ type: "text", text: replyBody }]
      };
    }

    if (name === "get_daily_summary") {
      const { phone, profileName, dateString, allowFallbackDays = 1 } = args as any;
      const firstName = profileName.trim().split(/\s+/)[0];
      const tabName = `${firstName} : ${phone}`;

      const logs = await getUserLogRows(tabName);
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: `❌ I couldn't find any logged meals in your spreadsheet tab yet ("${tabName}"). Send me a photo of your food to start logging! 📸` }]
        };
      }

      const targetDate = dateString || new Date().toLocaleDateString('en-US');

      let filteredLogs = logs.filter(log => {
        try {
          const logTime = new Date(log.timestamp);
          const logDate = logTime.toLocaleDateString('en-US');
          return logDate === targetDate;
        } catch {
          return false;
        }
      });

      let summaryDays = 1;
      let dateHeading = targetDate;

      if (filteredLogs.length === 0 && allowFallbackDays > 1) {
        console.error(`[MCP Server] No logs found for ${targetDate}. Searching fallback window of ${allowFallbackDays} days...`);
        const targetDateTime = new Date(targetDate).getTime();

        filteredLogs = logs.filter(log => {
          try {
            const logTime = new Date(log.timestamp);
            const diffTime = targetDateTime - logTime.getTime();
            const diffDays = diffTime / (1000 * 60 * 60 * 24);
            return diffDays >= 0 && diffDays < allowFallbackDays;
          } catch {
            return false;
          }
        });

        if (filteredLogs.length > 0) {
          summaryDays = allowFallbackDays;
          const startDate = new Date(targetDateTime - (allowFallbackDays - 1) * 24 * 60 * 60 * 1000).toLocaleDateString('en-US');
          dateHeading = `${startDate} - ${targetDate}`;
        }
      }

      if (filteredLogs.length === 0) {
        return {
          content: [{ type: "text", text: `🔍 I found logs in your tab, but none from today. Send a new photo of your food to log your meals today and request a summary! 🍳` }]
        };
      }

      const summaryText = await generateNutritionSummary(filteredLogs, summaryDays, dateHeading);
      return {
        content: [
          { type: "text", text: summaryText }
        ]
      };
    }

    if (name === "query_history") {
      const { phone, profileName, query } = args as any;
      const firstName = profileName.trim().split(/\s+/)[0];
      const tabName = `${firstName} : ${phone}`;

      const logs = await getUserLogRows(tabName);
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: `❌ I couldn't find any logged meals in your spreadsheet tab yet ("${tabName}"). Send me a photo of your food to start tracking!` }]
        };
      }

      const answer = await answerUserQuery(logs, query);
      return {
        content: [{ type: "text", text: answer }]
      };
    }

    if (name === "update_settings") {
      const { phone, status } = args as any;
      await optOutUser(phone, status);
      return {
        content: [{ type: "text", text: `Successfully updated preference for ${phone} to ${status}.` }]
      };
    }

    if (name === "get_inactivity_inspiration") {
      const { phone, profileName } = args as any;
      const firstName = profileName.trim().split(/\s+/)[0];
      const tabName = `${firstName} : ${phone}`;

      const logs = await getUserLogRows(tabName);
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: "No logs available." }]
        };
      }

      const msg = await generateInactivityInspiration(logs);
      return {
        content: [{ type: "text", text: msg }]
      };
    }

    return {
      content: [{ type: "text", text: `Error: Tool ${name} not found.` }],
      isError: true
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error executing tool: ${error.message || error}` }],
      isError: true
    };
  }
});

// Express app for the standalone MCP SSE server
const app = express();
const PORT = process.env.MCP_PORT || 3001;

app.use(bodyParser.json({ limit: '50mb' }));

const transports: Record<string, SSEServerTransport> = {};

// SSE endpoint to establish the connection stream
app.get("/sse", async (req, res) => {
  console.error("[MCP Server] Received GET request to /sse (establishing SSE stream)");
  try {
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    transport.onclose = () => {
      console.error(`[MCP Server] SSE transport closed for session ${sessionId}`);
      delete transports[sessionId];
    };

    await server.connect(transport);
    console.error(`[MCP Server] Established SSE stream with session ID: ${sessionId}`);
  } catch (error) {
    console.error("[MCP Server] Error establishing SSE stream:", error);
    if (!res.headersSent) {
      res.status(500).send("Error establishing SSE stream");
    }
  }
});

// Messages endpoint for client JSON-RPC tool requests
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    console.error("[MCP Server] Missing sessionId parameter in POST request");
    res.status(400).send("Missing sessionId parameter");
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    console.error(`[MCP Server] Session not found: ${sessionId}`);
    res.status(404).send("Session not found");
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("[MCP Server] Error handling request:", error);
    if (!res.headersSent) {
      res.status(500).send("Error handling request");
    }
  }
});

app.listen(PORT, () => {
  console.error(`[MCP Server] Independent MCP SSE Server listening on port ${PORT}`);
  console.error(`[MCP Server] SSE endpoint: http://localhost:${PORT}/sse`);
});
