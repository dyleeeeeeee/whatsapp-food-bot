/**
 * Script to subscribe the app to a WhatsApp Business Account (WABA).
 * This is REQUIRED to receive incoming message webhooks.
 *
 * Usage:
 *   node scripts/subscribe-waba.js <WABA_ID> <ACCESS_TOKEN>
 *
 * Environment Variables (alternative to args):
 *   - WABA_ID: Your WhatsApp Business Account ID
 *   - WHATSAPP_TOKEN: Your permanent access token
 *
 * Example:
 *   node scripts/subscribe-waba.js 1234567890 EAAxxxxx
 */

async function subscribeWABA(wabaId, accessToken) {
  const version = process.env.GRAPH_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('WABA subscription failed:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('WABA subscription successful!');
  console.log(JSON.stringify(data, null, 2));
  console.log('\nYour app is now subscribed to the WhatsApp Business Account.');
  console.log('Incoming messages will now be delivered to your webhook.');
}

// Main
(async () => {
  const wabaId = process.argv[2] || process.env.WABA_ID;
  const accessToken = process.argv[3] || process.env.WHATSAPP_TOKEN;

  if (!wabaId || !accessToken) {
    console.error('Error: WABA_ID and ACCESS_TOKEN are required.');
    console.error('\nUsage: node scripts/subscribe-waba.js <WABA_ID> <ACCESS_TOKEN>');
    console.error('   or: Set WABA_ID and WHATSAPP_TOKEN environment variables');
    process.exit(1);
  }

  await subscribeWABA(wabaId, accessToken);
})();
