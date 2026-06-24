/**
 * src/payments/router.js — Payment Initialization Wrapper (removed)
 *
 * DISC-03: The previous `initializePayment(order, env)` wrapper was dead code.
 * Nothing imported it — the live checkout path in src/handlers/user.js calls
 * `initializeFlutterwaveTransaction` from ./flutterwave.js directly. The
 * wrapper has been removed to avoid drift between two init paths.
 *
 * Intentionally left with no exports.
 */
