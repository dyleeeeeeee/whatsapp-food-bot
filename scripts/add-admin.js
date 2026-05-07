#!/usr/bin/env node
/**
 * Add a new admin user to the database.
 *
 * Usage:
 *   node scripts/add-admin.js <phone_number> [name]
 *
 * Example:
 *   node scripts/add-admin.js +2348123456789 "John Doe"
 *   node scripts/add-admin.js 2348123456789
 *
 * The phone number will be normalized (remove + and spaces).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read .dev.vars for local testing
function loadEnvVars() {
  const envPath = resolve(process.cwd(), '.dev.vars');
  const env = {};
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const [key, ...value] = line.split('=');
      if (key && value.length) {
        env[key.trim()] = value.join('=').trim();
      }
    }
  } catch {
    // ignore if file doesn't exist
  }
  return env;
}

const env = loadEnvVars();

const args = process.argv.slice(2);

if (args.length < 1) {
  console.log(`
Usage: node scripts/add-admin.js <phone_number> [name]

Arguments:
  phone_number  Phone number in E.164 format (e.g., +2348123456789 or 2348123456789)
  name          Optional admin name (default: "Admin")

Examples:
  node scripts/add-admin.js +2348123456789 "John Doe"
  node scripts/add-admin.js 2348123456789
`);
  process.exit(1);
}

let phoneNumber = args[0].replace(/\+/g, '').replace(/\s/g, '');
const adminName = args[1] || 'Admin';

// Basic validation
if (!/^\d{10,15}$/.test(phoneNumber)) {
  console.error('❌ Invalid phone number. Must be 10-15 digits.');
  process.exit(1);
}

console.log(`➕ Adding admin:`);
console.log(`   Phone: +${phoneNumber}`);
console.log(`   Name:  ${adminName}`);

// Build SQL
const sql = `INSERT OR IGNORE INTO AdminUsers (phone_number, name) VALUES ('${phoneNumber}', '${adminName}');`;

console.log(`\n📋 SQL to execute:`);
console.log(sql);

console.log(`\n🔧 Executing on remote database...`);

const { spawn } = await import('child_process');
const wrangler = spawn('wrangler', ['d1', 'execute', 'food-bot-db', '--remote', '--command', sql], { shell: true });

wrangler.stdout.on('data', (data) => {
  process.stdout.write(data);
});

wrangler.stderr.on('data', (data) => {
  process.stderr.write(data);
});

wrangler.on('close', (code) => {
  if (code === 0) {
    console.log(`\n✅ Admin added successfully!`);
    console.log(`   Phone: +${phoneNumber}`);
    console.log(`   Name:  ${adminName}`);
    console.log(`\n📖 The admin will have access immediately. No restart needed.`);
  } else {
    console.error(`\n❌ Failed to add admin. Exit code: ${code}`);
    console.error(`\n🔧 Manual command:`);
    console.error(`wrangler d1 execute food-bot-db --remote --command="${sql}"`);
  }
});
