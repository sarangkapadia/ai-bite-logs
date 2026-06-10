import { getUserSettingsMap } from '../services/sheets';
import dotenv from 'dotenv';

dotenv.config();

async function checkOptOuts() {
  try {
    const settings = await getUserSettingsMap();
    console.log('\n======================================');
    console.log('CURRENT REGISTERED USER SETTINGS:');
    console.log('======================================\n');
    
    if (settings.size === 0) {
      console.log('No registered users found in Settings sheet.');
      return;
    }

    settings.forEach((val, key) => {
      console.log(`Phone:               ${val.phone}`);
      console.log(`Status:              ${val.status}`);
      console.log(`Timezone:            ${val.timezone}`);
      console.log(`Last Auto Summary:   ${val.lastAutoSummaryDate || 'Never'}`);
      console.log(`Last Inact Check:    ${val.lastInactivityCheck || 'Never'}`);
      console.log(`Last Updated:        ${val.lastUpdated}`);
      console.log('--------------------------------------');
    });
  } catch (error) {
    console.error('Error fetching settings sheet:', error);
  }
}

checkOptOuts();
