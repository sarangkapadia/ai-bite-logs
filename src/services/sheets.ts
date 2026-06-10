import { google } from 'googleapis';
import { FoodNutritionInfo } from './gemini';
import { retryWithBackoff } from '../utils/retry';

// Keep track of which worksheets (tabs) we've already checked/initialized during server runtime
const initializedTabs = new Set<string>();

/**
 * Appends a food log entry as a new row in a specific tab of the Google Spreadsheet.
 * If the tab doesn't exist, it automatically creates it, sets up bold headers, and 
 * installs color-coded conditional formatting rules for the "Healthy?" column.
 * Uses exponential backoff to handle rate limits (HTTP 429).
 * 
 * @param info The food analysis results from Gemini.
 * @param imageWebhookUrls Optional array of URLs of the images from WhatsApp/Twilio.
 * @param tabName The name of the worksheet tab to log into (e.g. phone number). Defaults to 'Sheet1'.
 */
export async function appendFoodLogToSheets(
  info: FoodNutritionInfo,
  imageWebhookUrls?: string[],
  tabName: string = 'Sheet1'
): Promise<{ streakCount: number }> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Google Sheets environment variables are not fully configured in your .env file.');
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Define the core action to execute (with backoff support)
  const operation = async () => {
    // 1. Ensure the specific tab exists and has headers
    if (!initializedTabs.has(tabName)) {
      // Get all current worksheets in the spreadsheet
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];

      // If the tab doesn't exist, create it programmatically
      if (!existingSheetTitles.includes(tabName)) {
        console.log(`Worksheet tab "${tabName}" not found. Creating programmatically...`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: tabName,
                  },
                },
              },
            ],
          },
        });
      }

      // Fetch updated sheets list to retrieve the numerical GID (sheetId) for formatting
      const updatedSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheet = updatedSpreadsheet.data.sheets?.find(s => s.properties?.title === tabName);
      const targetSheetId = targetSheet?.properties?.sheetId;

      // Check if the tab is empty to append headers
      const checkHeaders = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}!A1:I1`,
      });

      const headerValues = checkHeaders.data.values;
      const isSheetEmpty = !headerValues || headerValues.length === 0 || !headerValues[0] || headerValues[0].length === 0;

      if (isSheetEmpty && targetSheetId !== undefined) {
        console.log(`Worksheet "${tabName}" is empty. Creating bold headers and configuring conditional colors...`);
        
        // A. Write header texts
        const headers = [
          ['Timestamp', 'Food Name', 'Healthy?', 'Calories (kcal)', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Explanation', 'Image Link']
        ];
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A1:I1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: headers,
          },
        });

        // B. Apply Bold headers, Center Alignment, and Conditional Color Fills via batchUpdate
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              // 1. Format Header Row: Bold, centered, and filled with modern soft-gray color
              {
                repeatCell: {
                  range: {
                    sheetId: targetSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 9,
                  },
                  cell: {
                    userEnteredFormat: {
                      textFormat: {
                        bold: true,
                        fontSize: 11,
                      },
                      backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                      horizontalAlignment: 'CENTER',
                    },
                  },
                  fields: 'userEnteredFormat(textFormat(bold,fontSize),backgroundColor,horizontalAlignment)',
                },
              },
              // 2. Add Conditional Formatting: 'Healthy' -> Soft Green Background & Dark Green Text
              {
                addConditionalFormatRule: {
                  rule: {
                    ranges: [
                      {
                        sheetId: targetSheetId,
                        startRowIndex: 1, // Start below header row
                        startColumnIndex: 2, // Column C (Healthy?)
                        endColumnIndex: 3,
                      },
                    ],
                    booleanRule: {
                      condition: {
                        type: 'TEXT_EQ',
                        values: [{ userEnteredValue: 'Healthy' }],
                      },
                      format: {
                        backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 },
                        textFormat: { foregroundColor: { red: 0.1, green: 0.5, blue: 0.1 }, bold: true },
                      },
                    },
                  },
                  index: 0,
                },
              },
              // 3. Add Conditional Formatting: 'Moderation' -> Soft Yellow Background & Dark Gold Text
              {
                addConditionalFormatRule: {
                  rule: {
                    ranges: [
                      {
                        sheetId: targetSheetId,
                        startRowIndex: 1,
                        startColumnIndex: 2,
                        endColumnIndex: 3,
                      },
                    ],
                    booleanRule: {
                      condition: {
                        type: 'TEXT_EQ',
                        values: [{ userEnteredValue: 'Moderation' }],
                      },
                      format: {
                        backgroundColor: { red: 1.0, green: 0.96, blue: 0.8 },
                        textFormat: { foregroundColor: { red: 0.6, green: 0.45, blue: 0.0 }, bold: true },
                      },
                    },
                  },
                  index: 1,
                },
              },
              // 4. Add Conditional Formatting: 'Unhealthy' -> Soft Red Background & Dark Red Text
              {
                addConditionalFormatRule: {
                  rule: {
                    ranges: [
                      {
                        sheetId: targetSheetId,
                        startRowIndex: 1,
                        startColumnIndex: 2,
                        endColumnIndex: 3,
                      },
                    ],
                    booleanRule: {
                      condition: {
                        type: 'TEXT_EQ',
                        values: [{ userEnteredValue: 'Unhealthy' }],
                      },
                      format: {
                        backgroundColor: { red: 0.96, green: 0.86, blue: 0.86 },
                        textFormat: { foregroundColor: { red: 0.8, green: 0.1, blue: 0.1 }, bold: true },
                      },
                    },
                  },
                  index: 2,
                },
              },
            ] as any,
          },
        });
      }
      
      // Store that we've successfully initialized this tab
      initializedTabs.add(tabName);
    }

    // 2. Format the current time for log
    const timestamp = new Date().toLocaleString('en-US', {
      timeZoneName: 'short',
    });

    // 3. Render first image as thumbnail in the cell
    const firstImageUrl = imageWebhookUrls && imageWebhookUrls.length > 0 ? imageWebhookUrls[0] : undefined;
    const imageCellFormula = firstImageUrl ? `=IMAGE("${firstImageUrl}")` : 'N/A';

    // 4. Append the new row data
    const newRow = [
      [
        timestamp,
        info.foodName,
        info.healthStatus,
        info.calories,
        info.proteinGrams,
        info.carbsGrams,
        info.fatGrams,
        info.briefExplanation,
        imageCellFormula
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:I`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: newRow,
      },
    });

    console.log(`Successfully logged "${info.foodName}" to tab "${tabName}".`);
  };

  // Run the operation wrapping it in retry logic to prevent rate-limit crashes
  await retryWithBackoff(operation);

  // Update the user's lastLogDate and streak in settings registry
  let streakCount = 1;
  try {
    const phone = tabName.includes(' : ') ? tabName.split(' : ')[1] : tabName;
    const timestampStr = new Date().toLocaleString('en-US', { timeZoneName: 'short' });
    await updateLastLogDate(phone, timestampStr);
    streakCount = await updateUserStreak(phone);
  } catch (err) {
    console.error('Failed to update lastLogDate or streak count in appendFoodLogToSheets:', err);
  }
  return { streakCount };
}

export interface FoodLogRow {
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
 * Reads and returns all food log entries for a specific user tab.
 * 
 * @param tabName The name of the worksheet tab.
 */
export async function getUserLogRows(tabName: string): Promise<FoodLogRow[]> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Google Sheets environment variables are not fully configured in your .env file.');
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async (): Promise<FoodLogRow[]> => {
    try {
      // Check if worksheet exists first
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
      
      if (!existingSheetTitles.includes(tabName)) {
        return [];
      }

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}!A2:H`, // Read A to H below header row
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return [];
      }

      return rows.map((row) => ({
        timestamp: row[0] || '',
        foodName: row[1] || 'N/A',
        healthStatus: row[2] || 'Moderation',
        calories: parseInt(row[3] || '0', 10) || 0,
        proteinGrams: parseInt(row[4] || '0', 10) || 0,
        carbsGrams: parseInt(row[5] || '0', 10) || 0,
        fatGrams: parseInt(row[6] || '0', 10) || 0,
        briefExplanation: row[7] || '',
      }));
    } catch (error) {
      console.error(`Error reading logs for user ${tabName}:`, error);
      return [];
    }
  };

  return retryWithBackoff(operation);
}

/**
 * Retrieves all worksheets (tabs) inside the Google Spreadsheet that represent active user accounts.
 * Filtered to include only tabs named in the "Name : Phone" format.
 */
export async function getAllUserTabs(): Promise<{ title: string; sheetId: number }[]> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Google Sheets environment variables are not fully configured in your .env file.');
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async (): Promise<{ title: string; sheetId: number }[]> => {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    return (spreadsheet.data.sheets || [])
      .map(s => ({
        title: s.properties?.title || '',
        sheetId: s.properties?.sheetId || 0
      }))
      .filter(s => s.title.includes(' : ')); // Matches "Name : Phone" format
  };

  return retryWithBackoff(operation);
}

/**
/**
 * Guesses the standard IANA timezone name based on the phone number's country code prefix.
 */
export function guessTimezoneFromPhone(phone: string): string {
  const cleanPhone = phone.replace(/[^\d]/g, '');
  if (cleanPhone.startsWith('91')) return 'Asia/Kolkata';       // India
  if (cleanPhone.startsWith('44')) return 'Europe/London';       // UK
  if (cleanPhone.startsWith('61')) return 'Australia/Sydney';     // Australia
  if (cleanPhone.startsWith('49')) return 'Europe/Berlin';       // Germany
  if (cleanPhone.startsWith('33')) return 'Europe/Paris';        // France
  if (cleanPhone.startsWith('81')) return 'Asia/Tokyo';          // Japan
  if (cleanPhone.startsWith('65')) return 'Asia/Singapore';      // Singapore
  if (cleanPhone.startsWith('55')) return 'America/Sao_Paulo';    // Brazil
  if (cleanPhone.startsWith('27')) return 'Africa/Johannesburg';  // South Africa
  if (cleanPhone.startsWith('52')) return 'America/Mexico_City';  // Mexico
  if (cleanPhone.startsWith('34')) return 'Europe/Madrid';        // Spain
  if (cleanPhone.startsWith('39')) return 'Europe/Rome';          // Italy
  if (cleanPhone.startsWith('86')) return 'Asia/Shanghai';        // China
  if (cleanPhone.startsWith('7')) return 'Europe/Moscow';         // Russia
  if (cleanPhone.startsWith('971')) return 'Asia/Dubai';          // UAE
  if (cleanPhone.startsWith('62')) return 'Asia/Jakarta';         // Indonesia
  // Default to America/Los_Angeles for US/Canada (+1) and others
  return 'America/Los_Angeles';
}

export interface UserSettings {
  phone: string;
  status: 'Active' | 'Opted Out';
  lastUpdated: string;
  timezone: string;
  lastAutoSummaryDate: string;
  lastInactivityCheck: string;
  lastLogDate: string;
  streakCount: number;
  lastActiveDate: string;
  twilioAccountSid?: string;
}

/**
 * Opts a user's phone number in or out of daily proactive summary reports.
 * Logs their preference inside a dedicated "Settings" tab in Google Sheets,
 * and initializes their timezone and last run status if they are new.
 */
export async function optOutUser(phone: string, status: 'opt-out' | 'opt-in'): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error('Google Sheets environment variables are not fully configured in your .env file.');
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async () => {
    const tabName = 'Settings';
    
    // Ensure "Settings" sheet exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
    
    if (!existingSheetTitles.includes(tabName)) {
      console.log('Settings sheet not found. Creating programmatically...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName }
              }
            }
          ]
        }
      });
      
      // Write headers and bold them
      const headers = [['Phone Number', 'Auto Summary Status', 'Last Updated', 'Timezone', 'Last Auto Summary Date', 'Last Inactivity Check', 'Last Log Date', 'Streak Count', 'Last Active Date', 'Twilio From Number']];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:J1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
      });
      
      // Get the sheet GID to apply formatting
      const updatedSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheetId = updatedSpreadsheet.data.sheets?.find(s => s.properties?.title === tabName)?.properties?.sheetId;
      
      if (targetSheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: targetSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                  },
                  cell: {
                    userEnteredFormat: {
                      textFormat: { bold: true, fontSize: 11 },
                      backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                      horizontalAlignment: 'CENTER',
                    }
                  },
                  fields: 'userEnteredFormat(textFormat(bold,fontSize),backgroundColor,horizontalAlignment)',
                }
              }
            ] as any
          }
        });
      }
    }

    // Read current Settings rows to see if phone number is already present
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A2:J`,
    });
    
    const rows = response.data.values || [];
    const cleanPhone = phone.replace(/[^\d]/g, '');
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });
    const statusText = status === 'opt-out' ? 'Opted Out' : 'Active';

    if (foundIndex !== -1) {
      // Row index in Sheets is 1-indexed, and we skip A1 header, so row number is foundIndex + 2
      const rowNum = foundIndex + 2;
      const existingRow = rows[foundIndex];
      const currentTimezone = existingRow[3] || guessTimezoneFromPhone(phone);
      const currentLastSummaryDate = existingRow[4] || '';
      const currentLastInactivityCheck = existingRow[5] || '';
      const currentLastLogDate = existingRow[6] || '';
      const currentStreak = existingRow[7] || '0';
      const currentLastActiveDate = existingRow[8] || '';
      const currentTwilioFrom = existingRow[9] || '';

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!B${rowNum}:J${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[statusText, timestamp, currentTimezone, currentLastSummaryDate, currentLastInactivityCheck, currentLastLogDate, currentStreak, currentLastActiveDate, currentTwilioFrom]]
        }
      });
      console.log(`Updated status for ${phone} to ${statusText} in Settings row ${rowNum}`);
    } else {
      // Phone number not found, append a new row
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, statusText, timestamp, defaultTimezone, '', '', '', '0', '', '']]
        }
      });
      console.log(`Appended status for ${phone} as ${statusText} in Settings`);
    }
  };

  return retryWithBackoff(operation);
}

/**
 * Reads the "Settings" sheet and returns a Set of phone numbers that have opted out of summaries.
 */
export async function getOptedOutUsers(): Promise<Set<string>> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) {
    return new Set<string>();
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async (): Promise<Set<string>> => {
    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
      
      if (!existingSheetTitles.includes('Settings')) {
        return new Set<string>();
      }

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Settings!A2:B',
      });

      const rows = response.data.values || [];
      const optedOut = new Set<string>();
      for (const row of rows) {
        const phone = row[0];
        const status = row[1];
        if (phone && status === 'Opted Out') {
          optedOut.add(phone);
        }
      }
      return optedOut;
    } catch {
      return new Set<string>();
    }
  };

  return retryWithBackoff(operation);
}

/**
 * Reads the "Settings" sheet and returns a Map of phone numbers to UserSettings.
 */
export async function getUserSettingsMap(): Promise<Map<string, UserSettings>> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) {
    return new Map<string, UserSettings>();
  }

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async (): Promise<Map<string, UserSettings>> => {
    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
      
      if (!existingSheetTitles.includes('Settings')) {
        return new Map<string, UserSettings>();
      }

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Settings!A2:J',
      });

      const rows = response.data.values || [];
      const settingsMap = new Map<string, UserSettings>();
      for (const row of rows) {
        const rawPhone = row[0];
        if (rawPhone) {
          const cleanPhone = rawPhone.replace(/[^\d]/g, '');
          settingsMap.set(cleanPhone, {
            phone: rawPhone,
            status: (row[1] || 'Active') === 'Opted Out' ? 'Opted Out' : 'Active',
            lastUpdated: row[2] || '',
            timezone: row[3] || guessTimezoneFromPhone(rawPhone),
            lastAutoSummaryDate: row[4] || '',
            lastInactivityCheck: row[5] || '',
            lastLogDate: row[6] || '',
            streakCount: parseInt(row[7] || '0', 10),
            lastActiveDate: row[8] || '',
            twilioAccountSid: row[9] || '',
          });
        }
      }
      return settingsMap;
    } catch {
      return new Map<string, UserSettings>();
    }
  };

  return retryWithBackoff(operation);
}

/**
 * Updates the last auto-summary completion date for a specific phone number in the Settings sheet.
 */
export async function updateLastAutoSummaryDate(phone: string, dateStr: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return;

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async () => {
    const tabName = 'Settings';
    
    // Ensure "Settings" sheet exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
    
    if (!existingSheetTitles.includes(tabName)) {
      console.log('Settings sheet not found in updateLastAutoSummaryDate. Creating programmatically...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName }
              }
            }
          ]
        }
      });
      
      // Write headers and bold them
      const headers = [['Phone Number', 'Auto Summary Status', 'Last Updated', 'Timezone', 'Last Auto Summary Date', 'Last Inactivity Check', 'Last Log Date', 'Streak Count', 'Last Active Date', 'Twilio From Number']];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:J1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
      });
      
      // Get the sheet GID to apply formatting
      const updatedSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheetId = updatedSpreadsheet.data.sheets?.find(s => s.properties?.title === tabName)?.properties?.sheetId;
      
      if (targetSheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: targetSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                  },
                  cell: {
                    userEnteredFormat: {
                      textFormat: { bold: true, fontSize: 11 },
                      backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                      horizontalAlignment: 'CENTER',
                    }
                  },
                  fields: 'userEnteredFormat(textFormat(bold,fontSize),backgroundColor,horizontalAlignment)',
                }
              }
            ] as any
          }
        });
      }
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A2:J`,
    });
    
    const rows = response.data.values || [];
    const cleanPhone = phone.replace(/[^\d]/g, '');
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });

    if (foundIndex !== -1) {
      const rowNum = foundIndex + 2;
      const existingRow = rows[foundIndex];
      const statusText = existingRow[1] || 'Active';
      const timezoneText = existingRow[3] || guessTimezoneFromPhone(phone);
      const lastInactivityCheckText = existingRow[5] || '';
      const lastLogDateText = existingRow[6] || '';
      const currentStreak = existingRow[7] || '0';
      const currentLastActiveDate = existingRow[8] || '';
      const currentTwilioFrom = existingRow[9] || '';
      
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!B${rowNum}:J${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[statusText, timestamp, timezoneText, dateStr, lastInactivityCheckText, lastLogDateText, currentStreak, currentLastActiveDate, currentTwilioFrom]]
        }
      });
      console.log(`Updated last auto summary date for ${phone} to ${dateStr} in row ${rowNum}`);
    } else {
      // If user row is missing for some reason, create it
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, 'Active', timestamp, defaultTimezone, dateStr, '', '', '0', '', '']]
        }
      });
      console.log(`Appended entry for ${phone} with auto summary date ${dateStr} in Settings`);
    }
  };

  await retryWithBackoff(operation);
}

/**
 * Updates the last inactivity check-in timestamp for a specific phone number in the Settings sheet.
 */
export async function updateLastInactivityCheck(phone: string, timestampStr: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return;

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async () => {
    const tabName = 'Settings';
    
    // Ensure "Settings" sheet exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
    
    if (!existingSheetTitles.includes(tabName)) {
      console.log('Settings sheet not found in updateLastInactivityCheck. Creating programmatically...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName }
              }
            }
          ]
        }
      });
      
      // Write headers and bold them
      const headers = [['Phone Number', 'Auto Summary Status', 'Last Updated', 'Timezone', 'Last Auto Summary Date', 'Last Inactivity Check', 'Last Log Date', 'Streak Count', 'Last Active Date', 'Twilio From Number']];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:J1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
      });
      
      // Get the sheet GID to apply formatting
      const updatedSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheetId = updatedSpreadsheet.data.sheets?.find(s => s.properties?.title === tabName)?.properties?.sheetId;
      
      if (targetSheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: targetSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                  },
                  cell: {
                    userEnteredFormat: {
                      textFormat: { bold: true, fontSize: 11 },
                      backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                      horizontalAlignment: 'CENTER',
                    }
                  },
                  fields: 'userEnteredFormat(textFormat(bold,fontSize),backgroundColor,horizontalAlignment)',
                }
              }
            ] as any
          }
        });
      }
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A2:J`,
    });
    
    const rows = response.data.values || [];
    const cleanPhone = phone.replace(/[^\d]/g, '');
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });

    if (foundIndex !== -1) {
      const rowNum = foundIndex + 2;
      const existingRow = rows[foundIndex];
      const statusText = existingRow[1] || 'Active';
      const timezoneText = existingRow[3] || guessTimezoneFromPhone(phone);
      const lastSummaryDateText = existingRow[4] || '';
      const lastLogDateText = existingRow[6] || '';
      const currentStreak = existingRow[7] || '0';
      const currentLastActiveDate = existingRow[8] || '';
      const currentTwilioFrom = existingRow[9] || '';
      
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!B${rowNum}:J${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[statusText, timestamp, timezoneText, lastSummaryDateText, timestampStr, lastLogDateText, currentStreak, currentLastActiveDate, currentTwilioFrom]]
        }
      });
      console.log(`Updated last inactivity check for ${phone} to ${timestampStr} in row ${rowNum}`);
    } else {
      // If user row is missing for some reason, create it
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, 'Active', timestamp, defaultTimezone, '', timestampStr, '', '0', '', '']]
        }
      });
      console.log(`Appended entry for ${phone} with last inactivity check ${timestampStr} in Settings`);
    }
  };

  await retryWithBackoff(operation);
}

/**
 * Updates the last logged date/time for a specific phone number in the Settings sheet.
 */
export async function updateLastLogDate(phone: string, dateStr: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return;

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async () => {
    const tabName = 'Settings';
    
    // Ensure "Settings" sheet exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
    
    if (!existingSheetTitles.includes(tabName)) {
      console.log('Settings sheet not found in updateLastLogDate. Creating programmatically...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName }
              }
            }
          ]
        }
      });
      
      // Write headers and bold them
      const headers = [['Phone Number', 'Auto Summary Status', 'Last Updated', 'Timezone', 'Last Auto Summary Date', 'Last Inactivity Check', 'Last Log Date', 'Streak Count', 'Last Active Date', 'Twilio From Number']];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:J1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
      });
      
      // Get the sheet GID to apply formatting
      const updatedSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheetId = updatedSpreadsheet.data.sheets?.find(s => s.properties?.title === tabName)?.properties?.sheetId;
      
      if (targetSheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: targetSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                  },
                  cell: {
                    userEnteredFormat: {
                      textFormat: { bold: true, fontSize: 11 },
                      backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                      horizontalAlignment: 'CENTER',
                    }
                  },
                  fields: 'userEnteredFormat(textFormat(bold,fontSize),backgroundColor,horizontalAlignment)',
                }
              }
            ] as any
          }
        });
      }
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A2:J`,
    });
    
    const rows = response.data.values || [];
    const cleanPhone = phone.replace(/[^\d]/g, '');
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });

    if (foundIndex !== -1) {
      const rowNum = foundIndex + 2;
      const existingRow = rows[foundIndex];
      const statusText = existingRow[1] || 'Active';
      const timezoneText = existingRow[3] || guessTimezoneFromPhone(phone);
      const lastSummaryDateText = existingRow[4] || '';
      const lastInactivityCheckText = existingRow[5] || '';
      const streakText = existingRow[7] || '0';
      const lastActiveDateText = existingRow[8] || '';
      const currentTwilioFrom = existingRow[9] || '';
      
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!B${rowNum}:J${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[statusText, timestamp, timezoneText, lastSummaryDateText, lastInactivityCheckText, dateStr, streakText, lastActiveDateText, currentTwilioFrom]]
        }
      });
      console.log(`Updated last logged date for ${phone} to ${dateStr} in row ${rowNum}`);
    } else {
      // If user row is missing for some reason, create it
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, 'Active', timestamp, defaultTimezone, '', '', dateStr, '0', '', '']]
        }
      });
      console.log(`Appended entry for ${phone} with last logged date ${dateStr} in Settings`);
    }
  };

  await retryWithBackoff(operation);
}

/**
 * Calculates and updates the user's consecutive food logging streak.
 * The streak increments on every logged meal, resetting to 1 if a calendar day is skipped.
 */
export async function updateUserStreak(phone: string): Promise<number> {
  const settingsMap = await getUserSettingsMap();
  const cleanPhone = phone.replace(/[^\d]/g, '');
  const userSettings = settingsMap.get(cleanPhone);
  
  const userTimezone = userSettings?.timezone || guessTimezoneFromPhone(phone);
  
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: userTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  const now = new Date();
  const parts = formatter.formatToParts(now);
  const todayStr = `${parts.find(p => p.type === 'month')?.value}/${parts.find(p => p.type === 'day')?.value}/${parts.find(p => p.type === 'year')?.value}`;
  
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yParts = formatter.formatToParts(yesterday);
  const yesterdayStr = `${yParts.find(p => p.type === 'month')?.value}/${yParts.find(p => p.type === 'day')?.value}/${yParts.find(p => p.type === 'year')?.value}`;

  let currentStreak = 0;
  let lastActive = '';
  
  if (userSettings) {
    currentStreak = userSettings.streakCount || 0;
    lastActive = userSettings.lastActiveDate || '';
  }
  
  let newStreak = 1;
  
  if (lastActive === todayStr) {
    // Already logged today: user chose to stack/increment on every single logged meal!
    newStreak = currentStreak + 1;
  } else if (lastActive === yesterdayStr) {
    // Logged yesterday: increment streak
    newStreak = currentStreak + 1;
  } else {
    // Skipped a day or brand new user: reset to 1
    newStreak = 1;
  }
  
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (spreadsheetId && clientEmail && privateKey) {
    const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT({
      email: clientEmail,
      key: formattedPrivateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    
    // Find settings row index for this phone
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Settings!A2:J',
    });
    const rows = response.data.values || [];
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }
    
    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });
    if (foundIndex !== -1) {
      const rowNum = foundIndex + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Settings!H${rowNum}:I${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[newStreak, todayStr]]
        }
      });
    } else {
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `Settings!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, 'Active', timestamp, defaultTimezone, '', '', '', newStreak, todayStr, '']]
        }
      });
    }
  }
  
  return newStreak;
}

/**
 * Updates or sets the user's mapped Twilio Account SID in the Settings sheet.
 */
export async function updateUserTwilioAccountSid(phone: string, twilioAccountSid: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!spreadsheetId || !clientEmail || !privateKey) return;

  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: formattedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const operation = async () => {
    const tabName = 'Settings';
    
    // Ensure "Settings" sheet exists
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title) || [];
    
    if (!existingSheetTitles.includes(tabName)) {
      console.log('Settings sheet not found in updateUserTwilioAccountSid. Creating programmatically...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName }
              }
            }
          ]
        }
      });
      
      const headers = [['Phone Number', 'Auto Summary Status', 'Last Updated', 'Timezone', 'Last Auto Summary Date', 'Last Inactivity Check', 'Last Log Date', 'Streak Count', 'Last Active Date', 'Twilio Account SID']];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:J1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
      });
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A2:J`,
    });
    
    const rows = response.data.values || [];
    const cleanPhone = phone.replace(/[^\d]/g, '');
    let foundIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = (rows[i][0] || '').replace(/[^\d]/g, '');
      if (rowPhone === cleanPhone) {
        foundIndex = i;
        break;
      }
    }

    const timestamp = new Date().toLocaleString('en-US', { timeZoneName: 'short' });

    if (foundIndex !== -1) {
      const rowNum = foundIndex + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!J${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[twilioAccountSid]]
        }
      });
      console.log(`Updated Twilio Account SID for ${phone} to ${twilioAccountSid} in row ${rowNum}`);
    } else {
      const defaultTimezone = guessTimezoneFromPhone(phone);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[phone, 'Active', timestamp, defaultTimezone, '', '', '', '0', '', twilioAccountSid]]
        }
      });
      console.log(`Appended entry for ${phone} with Twilio Account SID ${twilioAccountSid} in Settings`);
    }
  };

  await retryWithBackoff(operation);
}
