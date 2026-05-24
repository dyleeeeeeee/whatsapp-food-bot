/**
 * src/payments/router.js — Payment Initialization Wrapper
 *
 * Simplified wrapper for Flutterwave payment initialization.
 * Previously supported multiple providers; now Flutterwave-only.
 */

import { initializeFlutterwaveTransaction } from './flutterwave.js';

/**
 * Initializes payment with Flutterwave.
 *
 * @param {Object} order - Order data
 * @param {number} order.id - Order ID
 * @param {number} order.total_price - Order total in base currency
 * @param {string} order.payment_reference - Unique payment reference
 * @param {string} order.user_phone - Customer phone number
 * @param {Object} env - Environment bindings
 * @returns {Promise<Object>} - Payment initialization response
 */
export async function initializePayment(order, env) {
  return await initializeFlutterwaveTransaction({
    amount: order.total_price,
    txRef: order.payment_reference,
    currency: 'NGN', // TODO: Support multi-currency based on country
    customer: {
      email: 'customer@fastchow.bot',
      phone_number: order.user_phone,
      name: 'Customer'
    },
    metadata: { orderId: order.id }
  }, env);
}
