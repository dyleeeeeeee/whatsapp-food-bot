---
description: Always Works verification for WhatsApp food bot changes
---

# Always Works Verification Workflow

Use this workflow after making ANY code changes to ensure they actually work.

## The 30-Second Reality Check - Must answer YES to ALL:
- Did I run/build the code?
- Did I trigger the exact feature I changed?
- Did I see the expected result with my own observation?
- Did I check for error messages?
- Would I bet $100 this works?

## Phrases to Avoid:
- "This should work now"
- "I've fixed the issue" (especially 2nd+ time)
- "Try it now" (without trying it myself)
- "The logic is correct so..."

## Verification Steps by Change Type:

### UI Changes (WhatsApp messages):
1. Build the code: `wrangler build`
2. Deploy to test environment
3. Send test WhatsApp message to trigger the flow
4. Verify the message appears correctly in WhatsApp
5. Check for character limits (1024 max for body text)
6. Test button/list interactions work

### Database Changes (D1):
1. Run the SQL change locally: `wrangler d1 execute food-bot-db --command "..."` 
2. Run on remote: `wrangler d1 execute food-bot-db --remote --command "..."`
3. Query to verify data: `wrangler d1 execute food-bot-db --remote --command "SELECT ..."`
4. Check foreign key constraints
5. Verify cache busting if menu data changed

### Handler Logic Changes (admin.js, user.js):
1. Build the code: `wrangler build`
2. Test the specific state flow via WhatsApp
3. Verify session state transitions correctly
4. Check error handling paths
5. Test edge cases (empty inputs, invalid data)

### Configuration Changes:
1. Update wrangler.toml or env vars
2. Build the code: `wrangler build`
3. Deploy: `wrangler deploy`
4. Verify the config loads correctly
5. Check logs for any startup errors

## Project-Specific Notes:

### WhatsApp API Limits:
- Button message: max 3 buttons, body ≤ 1024 chars
- List message: max 10 sections, max 10 rows/section
- Button reply ID: max 256 chars
- Button title: max 20 chars
- List row title: max 24 chars
- List row description: max 72 chars

### D1 Database:
- Primary tables: MenuCategories, MenuItems, Orders, OrderItems, AdminUsers, BulkActionLogs
- Foreign key: MenuItems.category_id → MenuCategories.id (CASCADE delete)
- Use wrangler d1 execute for SQL operations
- Bust menu cache after menu changes via `bustMenuCache()`

### Testing via WhatsApp:
- Use test phone number to trigger flows
- Check actual WhatsApp message rendering
- Verify button/list interactions work end-to-end
- Test error messages appear correctly

## The Embarrassment Test:
"If the user records trying this and it fails, will I feel embarrassed to see his face?"

## Time Reality:
- Time saved skipping tests: 30 seconds
- Time wasted when it doesn't work: 30 minutes
- User trust lost: Immeasurable
