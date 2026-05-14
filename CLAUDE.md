# How to ensure Always Works™ implementation
Please ensure your implementation Always Works™ for: $ARGUMENTS.

Follow this systematic approach:

## Core Philosophy
- "Should work" ≠ "does work" - Pattern matching isn't enough
- I'm not paid to write code, I'm paid to solve problems
- Untested code is just a guess, not a solution

# The 30-Second Reality Check - Must answer YES to ALL:
- Did I run/build the code?
- Did I trigger the exact feature I changed?
- Did I see the expected result with my own observation (including GUI)?
- Did I check for error messages?
- Would I bet $100 this works?

# Phrases to Avoid:
- "This should work now"
- "I've fixed the issue" (especially 2nd+ time)
- "Try it now" (without trying it myself)
- "The logic is correct so..."

# Specific Test Requirements:
- UI Changes: Actually click the button/link/form
- API Changes: Make the actual API call
- Data Changes: Query the database
- Logic Changes: Run the specific scenario
- Config Changes: Restart and verify it loads

# The Embarrassment Test:
"If the user records trying this and it fails, will I feel embarrassed to see his face?"

# Time Reality:
- Time saved skipping tests: 30 seconds
- Time wasted when it doesn't work: 30 minutes
- User trust lost: Immeasurable

A user describing a bug for the third time isn't thinking "this AI is trying hard" - they're thinking "why am I wasting time with this incompetent tool?"

- IF the file is large, prioritize learning from existing functions/systems so as not to break the code.
- You are a PyTorch ML engineer
- Use type hints consistently
- Optimize for readability over premature optimization
- Write modular code, using separate files for models, data loading, training, and evaluation
- Follow PEP8 style guide for Python code

# Mewbot guide
- For duels, their effects are linked to their effect_id, which exists in mongo, the pokemon db, moves table.
- BEFORE making database insertions, ensure the data will flow with the existing system and it works when "smoke tested" (i.e. it tallys with example user journeys in the bot like evolving, or forming, and duel form/mega-evolution effects, e.t.c)
- Before checking the JSON files in resources/ or shared/data/ ensure you have thoroughly checked the mongodb database, the mongodb is the primary source of truth for species data and it is the source of truth for moves and all other pokemon data.
- Carefully read all duel files before making changes to make sure it don't break.


# General guide.
- Prioritize readability and simplicity: Write code that is clear and easy to understand, avoiding unnecessary complexity or clever tricks. Focus on making the logic self-evident rather than relying on excessive abstractions or optimizations unless absolutely needed.

- Follow strict formatting conventions: Indent with 8-character tabs (not spaces), limit lines to around 80 columns for readability (but exceed if it improves clarity), and avoid trailing whitespace. Use K&R style for braces: opening braces on the same line for non-function blocks, on a new line for functions.

- Keep functions short and focused: Functions should handle one task, fit within one or two screenfuls, and limit local variables to 5-10. Avoid deep nesting (more than 3-4 levels) by refactoring; complexity should be inversely proportional to length.

- Use descriptive naming without fluff: Choose clear, lowercase names for globals (e.g., count_active_users); short names for locals (e.g., i for loops). Avoid Hungarian notation, mixed-case, or unnecessary typedefs—let types be handled by the compiler.

- Comment on purpose, not mechanics: Explain 'what' and 'why' before functions or blocks, not 'how' inline unless it's unusually tricky. Use kernel-doc for APIs, and prefer multi-line comments with leading asterisks for consistency.

- Avoid breaking existing behavior: Changes must maintain compatibility, especially for user-space APIs. Test for regressions in stability and performance, and justify any trade-offs clearly.

- Submit clean, focused patches: Each patch addresses one issue, builds standalone, and includes an imperative summary (e.g., "fix buffer overflow"). Use Signed-off-by, explain changes in detail, and go through maintainers.

- Communicate bluntly and honestly: Be direct in feedback, calling out flaws harshly if they waste time (e.g., labeling bad code as "garbage"), but focus on facts and technical issues, not personal attacks. Avoid politeness for its own sake or political games.

- Manage references explicitly: Use reference counting for shared data in multi-threaded environments to prevent leaks and races—no reliance on garbage collection.

- Shun over-engineering and premature features: Follow YAGNI—don't add abstractions for unneeded futures. Measure performance before optimizing, and prefer explicit code over macros unless they simplify without issues.

- Test rigorously and treat security as bugs: Validate inputs, handle errors gracefully, and use automated tests. View vulnerabilities as standard debugging problems, not special cases.

- Focus on data structures over code: Prioritize well-designed data and their relationships; good code follows from that. Minimize globals and use structs to group related data.

- Lead decisively as a benevolent dictator: Make firm technical decisions in your domain, saying "no" when needed, but build trust through consistent, project-focused choices. Communication is key in open source—read and write emails effectively, as coding takes a backseat in leadership.

# PartyScene Backstage — Architecture Reference

## Service Architecture
- 7 microservices deployed to GKE Autopilot (us-central1): auth, events, posts, users, media, payments, livestream
- All services share `shared/` library with `MicroService` base class (`shared/microservice/client.py`)
- ASGI server: Granian (Rust) with uvloop, `--task-impl rust`, `--runtime-mode mt`
- Most services run 1 Granian worker on 250m vCPU pods (auth uses `$(nproc)`)
- Port 5510 for all services
- Database: SurrealDB v2 (schemaless+schemafull, graph, geo, HNSW vectors)
- Connection pool: purreal (min=3, max=20 per service)
- Redis: max_connections=5 per service, used for JWT sharing, rate limiting, caching
- Message queue: RabbitMQ via FastStream, ormsgpack serialization
- Schema: `init/schema.surql` — single source of truth for all tables, indexes, triggers, stored functions

## Notification System (Novu)

### Architecture
- Registry pattern with auto-registration via `__init_subclass__`
- Base class: `shared/workers/novu/base.py` — `BaseNotification` (abstract, `workflow_id` triggers registration)
- Config: `shared/workers/novu/config.py` — `WorkflowID` class, all workflow IDs centralized here
- Manager: `shared/workers/novu/manager.py` — `NotificationManager` public facade, convenience methods
- Subscribers: `shared/workers/novu/subscribers.py` — Novu subscriber CRUD
- Notifications: `shared/workers/novu/notifications/` — one `@dataclass` file per type (self-registering)
- Legacy: `shared/workers/novu/notifications.py` — old monolithic class, superseded, do not use

### Adding a New Notification
1. Create `shared/workers/novu/notifications/<name>.py` — `@dataclass` subclass of `BaseNotification`
2. Add workflow ID to `shared/workers/novu/config.py` `WorkflowID` class
3. Import in `shared/workers/novu/notifications/__init__.py`
4. Import in `shared/workers/novu/manager.py` (registration import + convenience method)
5. Create email template in `shared/workers/novu/templates/<name>.html`
6. Create workflow in Novu dashboard with matching workflow ID

### Error Handling
- `critical = True` → exceptions propagate (used for OTP, recent-login — security-sensitive)
- `critical = False` → exceptions logged and swallowed (social/UX notifications)

### Subscriber ID = User ID
- Novu subscriber_id is the internal user ID (short UUID) — they are always in sync
- Device tokens (FCM/APNs) appended via `SubscriberService.append_device_token()`

### Existing Workflow IDs (as of 2026-04-01)
- `email-verification-flow` (OTP), `recent-login`, `welcome`, `friend-request`
- `event-invitation`, `event-reminder`, `livestream-notification`, `post-interaction`
- `ticket-purchase-host-notification`, `ticket-purchase-buyer-receipt`
- `password-reset-confirmation`, `event-recap`

## Novu SDK Constraints (novu-py)

### Payload
- Type: `Dict[str, Any]` — must be a dict at top level
- Nested dicts and lists of dicts are fully supported
- All values must be JSON-serializable (no Python `datetime`, `bytes`, or custom objects — convert to strings)
- **No SDK-side size limit**, but Novu API enforces ~256 KB total request body (HTTP 413 on exceed)
- Max 100 recipients per trigger call

### LiquidJS Email Templates (CRITICAL — NOT Handlebars)
Novu uses **LiquidJS**, not Handlebars. Every template in `shared/workers/novu/templates/` must use this syntax:

**Variables — must use `payload.` prefix:**
```
{{ payload.field_name }}
{{ payload.nested.field }}
```

**Conditionals:**
```
{% if payload.field != '' %}...{% endif %}
{% if payload.count > 0 %}...{% endif %}
{% if payload.flag == true %}...{% endif %}
```
- String comparisons MUST use single quotes: `{% if payload.status == 'active' %}`
- Double quotes are NOT supported in Liquid conditionals

**Loops:**
```
{% for item in payload.items %}
  {{ item.name }} — {{ item.price }}
{% endfor %}
```

**Loop helpers:**
- `forloop.first` — true on first iteration
- `forloop.last` — true on last iteration
- `{% unless forloop.last %}, {% endunless %}` — comma-separated lists

**What does NOT work in Novu's LiquidJS:**
- `{{ array.size }}` — NOT supported, use `forloop.first` pattern instead
- `{{ array.length }}` — NOT supported
- `{% if array != empty %}` — `empty` keyword NOT supported
- Handlebars syntax (`{{#if}}`, `{{#each}}`, `{{/if}}`, `{{this}}`) — completely wrong

**Pattern for conditional sections with arrays (no size/empty check needed):**
```
{% for item in payload.items %}
{% if forloop.first %}
<p>Section Header</p>
{% endif %}
  ...render item...
{% if forloop.last %}
</table>
{% endif %}
{% endfor %}
```
If the array is empty, the loop body never executes — the section is hidden automatically.

**Images:**
- URLs only (string values in payload) — no base64, no binary attachments
- Reference in template: `<img src="{{ payload.image_url }}">`

**Subscriber variables:** `{{ subscriber.firstName }}`, `{{ subscriber.data.custom_field }}`

## Event Lifecycle
- Status: `scheduled` → `live` → `ended` (or `scheduled` → `cancelled`)
- Status updated via `PATCH /events/<id>/status` (host-only, JWT-authenticated)
- `reminder_sent` field: set atomically when 1-hour pre-event reminder dispatched
- `recap_sent` field: set atomically when post-event recap dispatched
- `attendee_count`: denormalized counter, auto-incremented by SurrealDB trigger on `attends` CREATE
- `end_time`: always computed as `time + duration::from::mins(duration)` — never stored

## CronJob Pattern (Cloud Run Jobs)
- Located in `usr/Jobs/<name>/` with `recap.py`, `Dockerfile`, `requirements.txt`, `cloudbuild.yaml`
- K8s manifests in `k8s/<name>-cronjob.yaml`
- Atomic claiming pattern: `UPDATE...SET field = time::now() WHERE field = NONE RETURN BEFORE`
- This ensures idempotency — overlapping runs are safe, only one instance claims each record
- SurrealDB connection: direct `AsyncSurreal`, not purreal pool (jobs are short-lived)
- Build context is repo root so Dockerfile can `COPY shared/workers/novu/`

## Key Database Patterns
- `events` table is SCHEMALESS — can write any field without schema changes
- `fn::fetch_event($event_id)` returns full event detail: attendees, scanned/unscanned tickets, tiers, media, host
- Trending score: `(attendee_count * 3) + (post_count * 2)`
- Ticket tiers: max 3 per event, `sold_count` auto-incremented by SurrealDB trigger on ticket CREATE
- Ticket numbers: auto-generated `TKT-XXXX-XXXX` pattern

## SurrealDB Driver Patterns

### `query` vs `query_raw`
- `conn.query(sql, vars)` returns the **first** statement's result only. Safe for single-statement queries.
- `conn.query_raw(sql, vars)` returns the **full envelope**: `{"result": [{"status": "OK"|"ERR", "result": ...}, ...]}` — one entry per statement. Use this for any multi-statement aggregate.
- For multi-statement scripts, **always** prefer `query_raw` and pull `response["result"][-1]["result"]`. Walk the list first to surface any `status == "ERR"` so partial failures don't ship.
- Reference: `r18e/src/internals/connector.py` (recommendation engine), `users/src/connectors/__init__.py::fetch_host_profile` and `set_profile_slug`.

### Variable binding with `conn.let`
- `await conn.let("u", RecordID("users", uid))` binds a session-scoped variable usable across all subsequent statements in the same connection.
- Pair with `query_raw` so multi-`LET` blocks can reference `$u`, `$v`, etc. without re-binding inside every statement.
- Always reset/rebind per `pool.acquire()` block; pooled connections may be reused.

### Aggregate query shape
```python
async with self.pool.acquire() as conn:
    await conn.let("u", RecordID("users", user_id))
    response = await conn.query_raw(
        """
        LET $foo = SELECT ... FROM ... WHERE ... = $u;
        LET $bar = (SELECT count() FROM ... WHERE ... = $u GROUP ALL)[0].count ?? 0;
        RETURN { foo: $foo, bar: $bar };
        """
    )

statements = response.get("result", [])
for s in statements:
    if isinstance(s, dict) and s.get("status") == "ERR":
        raise Exception(f"... failed: {s.get('result')}")
payload = statements[-1]["result"]
```

### Built-in helpers worth reaching for before reimplementing
- `string::slug($raw)` — slugifies arbitrary input (`"DJ Mike!"` → `"dj-mike"`). Used for `users.profile_slug` so the client doesn't need to know our slug rules.
- `string::len`, `string::starts_with`, `string::concat`, `time::now`, `rand::string`, `array::len`, `count(...)` — prefer these over Python-side reimplementations when the value is consumed in SurrealQL.
- Geo: `geo::distance`, `Point` type with `location.coordinates`. HNSW: `<|K, EF|>` operator and `vector::distance::knn()` / `vector::similarity::cosine`.

### Multi-step writes
- For "validate then write" flows, do the validation in `query_raw` and the actual mutation in a follow-up `conn.query(...)` so the mutation only runs after we've inspected the validation payload (see `set_profile_slug`).
- For atomic claim patterns, keep using `UPDATE ... WHERE field = NONE RETURN BEFORE` (e.g. `reminder_sent`, `recap_sent`, ticket check-in).

## Rate Limiting
- Redis + atomic Lua script, 3 sliding windows per request
- Tiers: OTP (3/10/20), AUTH (10/100/500), MEDIA (30/500/2000), API (60/1000/10000), PUBLIC (120/2000/20000)
- Keys: SHA-256(IP:User-Agent) truncated to 16 hex chars, or JWT user ID

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.