# FastChow Operator & QA Guide

This document provides guidance for restaurant operators and quality assurance testing.

## Operator Checklist

### 🔑 User Management
- **Add Admin**: Run `node scripts/add-admin.js <phone> "<name>"` to grant admin access.
- **Verify Admins**: Run `wrangler d1 execute food-bot-db --remote --command="SELECT * FROM AdminUsers;"`.

### 🍽️ Menu Management
- **Add Item**: Admin Panel → Add Item. Follow the multi-step prompt (Name, Category, Price, Description, Image).
- **Edit Item**: Admin Panel → Edit Item. Select item and then the specific field to change.
- **Toggle Availability**: Admin Panel → Toggle Avail. Tap an item to flip it between Available and Unavailable.
- **Add Category**: Admin Panel → Add Category.

### 📦 Order Management
- **View Orders**: Admin Panel → View Orders. Shows a list of pending, confirmed, and preparing orders with payment status.
- **Update Status**: 
  1. Go to View Orders.
  2. Select the order from the list.
  3. Choose the new status (Confirmed, Preparing, Ready, Delivered, Cancelled).
  4. Note: Setting an order to `Delivered` or `Cancelled` requires a confirmation tap.

### 🏗️ Bulk Actions
- **Bulk Orders**: Admin Panel → Bulk Actions → Bulk Orders.
  1. Choose a status to apply.
  2. Select multiple orders from the paginated list.
  3. Review selection and choose notification behavior.
  4. If cancelling, provide a reason.
  5. Note: Unpaid Paystack orders are excluded from kitchen statuses (Confirmed, Preparing, Ready) by default.
- **Bulk Menu**: Admin Panel → Bulk Actions → Bulk Menu.
  1. Choose "Mark Available" or "Mark Unavailable".
  2. Select multiple menu items.
  3. Confirm to apply and bust the menu cache.

### 💳 Paystack Integration
- **Setup**:
  1. Set `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY` as Worker secrets.
  2. Configure Paystack Webhook URL to `https://<your-worker-domain>/paystack/webhook`.
  3. Enable `charge.success` in Paystack dashboard.
- **Workflow**:
  - Orders are created as `unpaid`.
  - Customers receive a Paystack link immediately after placing an order.
  - Payment status updates to `paid` automatically via webhook.
  - Customers receive a WhatsApp confirmation once paid.
  - Admins see `PAID` or `UNPAID` status in order lists.


---

## Manual QA Script (User Personas)

### 👤 Persona: The Hungry Student (First-time user)
1. Send "Hi" to the bot.
2. Verify welcome message and categories list.
3. Select a category (e.g., Burgers).
4. Select an item (e.g., Cheese Burger).
5. Verify item details show up with image (if available).
6. Tap "Add to Cart".
7. Enter quantity "2".
8. Enter notes "No pickles please".
9. Verify redirected to "My Cart".
10. Tap "Checkout".
11. Enter address "University Hall, Room 302".
12. Enter delivery notes "Leave at front desk".
13. Verify Order Summary shows everything correctly (items, address, notes, total).
14. Tap "Place Order".
15. Verify success message with Order ID.

### 👤 Persona: The Busy Parent (Editing & Recovery)
1. Add 3 different items to the cart.
2. Go to "My Cart".
3. Tap "Manage".
4. Select the first item.
5. Tap "Remove" and verify it's gone from the cart.
6. Select the second item.
7. Tap "Change Qty" and enter "5".
8. Verify quantity updated in cart summary.
9. Tap "Checkout".
10. Enter a short address (e.g., "Main").
11. Verify error message asking for at least 5 characters.
12. Enter full address.
13. On the next step (notes), type "BACK".
14. Verify returned to the address prompt.
15. Send "CANCEL" during checkout.
16. Verify confirmation prompt "Are you sure you want to cancel?".
17. Tap "No, Keep it" and verify returned to cart.

### 👤 Persona: The Order Tracker
1. Send "ORDERS" to the bot.
2. Select an active order from the list.
3. Verify detailed view shows status, items, address, and timestamp.
4. Verify "Back to History" button works.

### 👤 Persona: The Restaurant Manager (Admin)
1. Send "ADMIN" from a registered admin number.
2. Tap "View Orders".
3. Select a "PENDING" order.
4. Update status to "CONFIRMED".
5. Verify the admin gets a success message.
6. (If possible) Verify the customer receives a status update notification.
7. Try to delete an item that has active orders (verify system handles it gracefully).
