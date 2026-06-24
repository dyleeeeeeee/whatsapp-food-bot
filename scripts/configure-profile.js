/**
 * Script to configure the WhatsApp "conversational automation" profile:
 * Ice Breakers (the menu shown to a customer on first contact) and
 * Commands (the "/" slash-command autocomplete list).
 *
 * This is a one-time setup call against the Graph API. Re-running it
 * OVERWRITES the existing ice breakers / commands with the values below.
 *
 * Usage:
 *   node scripts/configure-profile.js <PHONE_NUMBER_ID> <ACCESS_TOKEN>
 *
 * Environment Variables (alternative to args):
 *   - PHONE_NUMBER_ID: Your WhatsApp phone number ID
 *   - WHATSAPP_TOKEN:  Your permanent access token
 *
 * Example:
 *   node scripts/configure-profile.js 1234567890 EAAxxxxx
 *
 * UX-08 (ice breakers) / UX-15 (commands).
 */

// Ice Breakers: tappable shortcuts shown to new customers. Each one sends
// its `payload` to the bot as a normal text message, so the payloads below
// match the keywords the bot already understands (MENU/ORDERS/CART/HELP).
// WhatsApp allows a maximum of 4 ice breakers.
const ICE_BREAKERS = [
  { question: '🍔 View Menu',    payload: 'MENU'   },
  { question: '📦 Track Order',  payload: 'ORDERS' },
  { question: '🛒 My Cart',      payload: 'CART'   },
  { question: '❓ Help',         payload: 'HELP'   },
];

// Commands: the "/" autocomplete list. `command_name` is typed WITHOUT the
// leading slash; WhatsApp renders the slash in the UI.
const COMMANDS = [
  { command_name: 'menu',   command_description: 'Browse the food menu'        },
  { command_name: 'orders', command_description: 'Track your active orders'    },
  { command_name: 'cart',   command_description: 'View your shopping cart'     },
  { command_name: 'help',   command_description: 'Get help using the bot'      },
  { command_name: 'admin',  command_description: 'Admin tools (admins only)'   },
];

async function configureProfile(phoneNumberId, accessToken) {
  const version = process.env.GRAPH_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/conversational_automation`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      enable_welcome_message: true,
      prompts: ICE_BREAKERS,
      commands: COMMANDS,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Profile configuration failed:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Profile configuration successful!');
  console.log(JSON.stringify(data, null, 2));
  console.log(`\n${ICE_BREAKERS.length} ice breakers and ${COMMANDS.length} commands are now live.`);
  console.log('New customers will see the ice breakers; "/" shows the command list.');
}

// Main
(async () => {
  const phoneNumberId = process.argv[2] || process.env.PHONE_NUMBER_ID;
  const accessToken = process.argv[3] || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.error('Error: PHONE_NUMBER_ID and ACCESS_TOKEN are required.');
    console.error('\nUsage: node scripts/configure-profile.js <PHONE_NUMBER_ID> <ACCESS_TOKEN>');
    console.error('   or: Set PHONE_NUMBER_ID and WHATSAPP_TOKEN environment variables');
    process.exit(1);
  }

  await configureProfile(phoneNumberId, accessToken);
})();
