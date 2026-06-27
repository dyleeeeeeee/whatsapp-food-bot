import { sendText } from '../whatsapp.js';
import { getAdminPhones } from '../db.js';

// ─────────────────────────────────────────────────────────────
// Best-effort admin alerting for payment-critical failures.
//
// Pings EVERY registered admin (from the AdminUsers table) over WhatsApp,
// plus an optional extra ADMIN_ALERT_PHONE, and records the alert in KV.
// To avoid spamming admins (the reconciliation cron runs every 5 min), the
// same alert is sent at most once per hour. This is a diagnostic
// side-channel: it MUST never throw and must never break the caller's flow.
// ─────────────────────────────────────────────────────────────

const ALERT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — KV audit record
const SEND_DEDUP_SECONDS = 60 * 60;         // 1 hour — re-send window per issue

// Short, stable hash of arbitrary text (FNV-1a, base36). Used to make
// the KV key unique-per-detail without depending on Date/time.
function shortHash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

export async function alertAdmin(env, event, detail) {
	const detailStr =
		typeof detail === 'string' ? detail : safeStringify(detail);
	const message = `[ALERT] ${event}\n${detailStr}`;
	const hash = shortHash(detailStr);

	// Send-dedup gate: don't re-ping admins about the same issue more than
	// once per hour (the */5 reconciliation cron would otherwise spam them).
	const sentKey = `alertsent:${event}:${hash}`;
	let alreadySent = false;
	if (env && env.SESSION_KV) {
		try {
			alreadySent = (await env.SESSION_KV.get(sentKey)) !== null;
		} catch { /* KV read failure — fall through and attempt the send */ }
	}

	if (!alreadySent) {
		// Recipients = every registered admin, plus an optional extra phone.
		const recipients = new Set();
		try {
			for (const p of await getAdminPhones(env)) if (p) recipients.add(p);
		} catch (err) {
			console.error('[alertAdmin] could not load admin phones:', err);
		}
		if (env && env.ADMIN_ALERT_PHONE) recipients.add(env.ADMIN_ALERT_PHONE);

		for (const to of recipients) {
			try {
				await sendText(to, message, env);
			} catch (err) {
				console.error('[alertAdmin] WhatsApp ping failed for', String(to).slice(-4), err);
			}
		}

		if (env && env.SESSION_KV) {
			try {
				await env.SESSION_KV.put(sentKey, '1', { expirationTtl: SEND_DEDUP_SECONDS });
			} catch { /* best effort */ }
		}
	}

	// KV audit record (7-day), regardless of the send-dedup gate.
	if (env && env.SESSION_KV) {
		try {
			await env.SESSION_KV.put(
				`alert:${event}:${hash}`,
				JSON.stringify({ event, detail: detailStr, at: new Date().toISOString() }),
				{ expirationTtl: ALERT_TTL_SECONDS }
			);
		} catch (err) {
			console.error('[alertAdmin] KV write failed:', err);
		}
	}
}

function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch (err) {
		return String(value);
	}
}
