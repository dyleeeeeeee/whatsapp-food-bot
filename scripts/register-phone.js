/**
 * Script to register a phone number to the WhatsApp Cloud API.
 *
 * Usage:
 *   node scripts/register-phone.js <PHONE_NUMBER_ID> <ACCESS_TOKEN> [PIN]
 *
 * Environment Variables (alternative to args):
 *   - PHONE_NUMBER_ID: Your WhatsApp phone number ID
 *   - WHATSAPP_TOKEN: Your permanent access token
 *   - REGISTRATION_PIN: 6-digit PIN (optional, defaults to random)
 *
 * Example:
 *   node scripts/register-phone.js 1234567890 EAAxxxxx 123456
 */

async function registerPhone(phoneNumberId, accessToken, pin) {
  const version = process.env.GRAPH_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/register`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      pin: pin,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Registration failed:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Registration successful!');
  console.log(JSON.stringify(data, null, 2));
  console.log('\nYour phone number is now registered with the WhatsApp Cloud API.');
  console.log(`PIN set: ${pin} (save this for future use)`);
}

// Main
(async () => {
  const phoneNumberId = process.argv[2] || process.env.PHONE_NUMBER_ID;
  const accessToken = process.argv[3] || process.env.WHATSAPP_TOKEN;
  let pin = process.argv[4] || process.env.REGISTRATION_PIN;

  if (!phoneNumberId || !accessToken) {
    console.error('Error: PHONE_NUMBER_ID and ACCESS_TOKEN are required.');
    console.error('\nUsage: node scripts/register-phone.js <PHONE_NUMBER_ID> <ACCESS_TOKEN> [PIN]');
    console.error('   or: Set PHONE_NUMBER_ID and WHATSAPP_TOKEN environment variables');
    process.exit(1);
  }

  // Generate random 6-digit PIN if not provided
  if (!pin) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    console.log(`No PIN provided. Generated PIN: ${pin}`);
  }

  // Validate PIN is 6 digits
  if (!/^\d{6}$/.test(pin)) {
    console.error('Error: PIN must be exactly 6 digits.');
    process.exit(1);
  }

  await registerPhone(phoneNumberId, accessToken, pin);
})();
