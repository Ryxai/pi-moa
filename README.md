# pi-moa

Mixture of Models for the [pi](https://pi.dev) coding agent. Before your model (the "actor") answers,
1–3 advisor models look at the conversation and give advice that the actor sees for that one request only.
The design is in [PLAN.md](PLAN.md).

**Status: all planned steps built**, plus effort levels, verdicts, an optional synthesis slot and
a before-done review (step 10). MoA is active via `/moa on` (session toggle), a one-shot
`/moa <prompt>`, or by selecting a `moa/<preset>` virtual model (optional). While active, the
preset's advisors run when one of its triggers fires; their advice is added to that request only,
and each fresh round is saved as a `moa` session entry with its trigger.

**What advisors see** (`context.view`, default `"auto"`):
- `native` (auto: the advisor is the actor's model, e.g. `"current"`): the actor's own request —
  system prompt, tools, transcript and same-model thinking, projected as pi projects it (a prompt
  forced by a `before_agent_start` handler, hidden tool declarations, `images.blockImages`) —
  plus one trailing user message with the advisor's instructions. It uses the actor's thinking
  level unless the advisor sets `thinking` or its own `effort` (see Effort), and the actor's
  session id, so it can reuse the actor's prompt cache. `context.nativeToolChoice` (default `"omit"`) sends no tool choice, which keeps
  the request cache-compatible with the actor's; only the reply's text is used, and a tool-call reply with
  no text is retried once with tool choice `none` (recorded as `retried`). `"none"` always sends
  `none` (on Anthropic this stops it reading the actor's cached messages). Bedrock never gets
  `none` (pi then drops the tool config, which Bedrock rejects with tool history). Project
  instructions are already in the actor's system prompt. Native views are not trimmed, including
  `view: "native"` forced on a different model. It also gets pi's `thinkingBudgets` setting, as the
  actor does. Limit: hidden tool declarations are taken from the run's start; if pi changes that
  set on a later step of the run, the native request can differ from the actor's.
- `text` (auto: any other model): a system prompt with the advisor rules and role, plus, with
  `projectInstructions` (default on), the project context files pi loaded for the current run
  (AGENTS.md etc., from `before_agent_start`) under "# Project instructions", capped at 8000
  characters head and tail. The transcript is plain text: tool calls as `⟨tool name(args)⟩`, tool
  results cut to `toolResultChars` as their own user turns, thinking dropped, images as `[image]`.
  Text advisors think at the round's effort level unless `thinking` is set (`"off"` for none) and
  use a per-slot session id.
- **Trimming** (text view, when the advisor model's `contextWindow` is known): the view is kept
  under `contextWindow × 0.9 − reserve` tokens, estimated at 3 characters per token; the reserve
  is the advisor's output cap (`maxTokens`, else the effort level's) plus the thinking budget for
  its thinking level, capped at half the window. Over that, the oldest messages are replaced by
  `[… N earlier messages omitted …]`; the last two steps, the last message and the `pin` items
  stay (`task`: the turn's user message; `latestError`: the latest failed tool result and its
  call; `latestDiff`: the latest file-changing call — edit/write-style tool names, or a path plus
  content/diff arguments — and its result). Cuts are made in chunks of 30% of the budget, so after
  a cut the view is at most ~70% full and keeps the same prefix for several steps, which keeps
  advisor prompt caching working. The prefix also changes when a newer error, edit or user
  message replaces a pinned one in the trimmed part. If the kept messages alone are too big, the
  largest are shortened head and tail; then the prefix changes every step.

**Triggers** (per preset, default `["user_turn", "on_failure"]`):
- `user_turn`: the first request after a user message (including steering and follow-up messages;
  messages other extensions add with `sendMessage` do not start a new turn);
- `every_step`: every request;
- `{ "every_n": N }`: the first request of the turn and every Nth step after it;
- `on_failure`: a streak of `onFailure.consecutiveErrors` failed tool results in a row, or of the
  same tool call (name and arguments) `onFailure.repeatedCalls` times in a row, within the turn —
  when a streak first reaches N, and again at every further N;
- `before_done`: when a reply ends the turn, advisors review the work (see Before-done review).

On steps where nothing fires, the turn's latest advice is reused, with a note that it predates the
newest tool results; with no advice yet this turn, the request goes out without any. A retried
request for a step that already had a round reuses it instead of calling the advisors again, and
interrupted rounds are discarded. If a round cannot run, the turn's earlier advice is used. If
compaction summarises away the turn's user message mid-turn, the turn's advice is kept and always
marked stale; `on_failure` and `every_step` keep working, and `every_n` counts steps from the
summary.

**Effort** (`effort`, default `"medium"`; per preset, or per advisor slot): how hard advisors work.
A level is a bundle: the thinking level pi sends (mapped to the provider's effort or thinking
budget and clamped to what the model supports), the output cap, and the length guidance in the
advisor prompt. The flat "about 400 words" rule is gone; each level has its own line.

| effort | thinking | maxTokens | length guidance |
|---|---|---|---|
| `low` | low | 1024 | about 120 words: the single best next step, at most two risks |
| `medium` | medium | 2048 | about 300 words unless the problem truly needs more |
| `high` | high | 4096 | about 600 words; say what to verify and how |
| `max` | max | 8192 | no limit, but a three-to-five-line summary first |

A slot's explicit `thinking` or `maxTokens` overrides the level's value. `on_failure`,
`before_done` and `consult` rounds run one level above the base (the problem is harder by then);
`user_turn`, `every_step` and `every_n` rounds run at the base. The actor's `consult` call can
pass `effort` to request a level outright. Nothing ever exceeds the preset's `maxEffort` (default
`"max"`). Native-view advisors share the actor's prompt cache, which a different thinking level
would invalidate on some providers, so for them the level only sets the output cap and length
line and thinking stays the actor's, unless the slot sets its own `effort` or `thinking`. The
level each advisor ran at is recorded and shown on its card line. Length guidance is about 80% of
what the cap allows, so a reply rarely hits it; one that does is marked (see Cleaning).

**Verdicts:** every advisor is asked to open with one line, `Verdict: on-track` (carry on),
`Verdict: revise` (change something first; it says what) or `Verdict: blocked` (only the user can
move it forward). The line stays in the advice the actor sees, is parsed into the record (shown on
the round card, most severe first, e.g. `revise ×2, on-track`), and decides the before-done review.
A missing or unrecognised line is simply no verdict.

**Synthesis** (`synthesis`, optional per preset: `{ "model", "thinking", "maxTokens", "prompt" }`):
with two or more advisors, their advice is unreconciled, so the framing says so and tells the actor
to decide from the transcript where they disagree. A synthesis slot adds one call after the round
(text view of the transcript plus the advisors' advice, with `maxTokens` 1024 by default and no
thinking unless set) whose only job is to reconcile real disagreements. It replies exactly
`No reconciliation needed.` when the advisors agree or differ only in emphasis, and that reply is
dropped: the actor sees nothing from it. Otherwise it opens with its own verdict and, in about 150
words, names each disagreement, says which side the transcript supports, and gives one
recommendation; that is appended as a `Synthesis:` block after the advisors, with a note replacing
the unreconciled one. It never runs with one advisor or when fewer than two answered, its cost
counts toward the budget, and a failed synthesis leaves the advisors' advice as it was.

**Before-done review** (`"before_done"` in `triggers`; off by default): when the actor's reply
ends the turn (no tool calls, i.e. it considers the task done or is handing back to the user), the
preset's advisors review the work at `turn_end`, asked whether anything is incomplete, unverified,
wrong or left out, one effort level above the base. The round is recorded like any other
(reason `before_done`). On a combined verdict of `revise` (any advisor, or the synthesis when it
spoke with a verdict) the framed advice is appended as a `moa-review` message, with a preamble
saying the turn would have ended and the actor should continue on the points that hold up or say
why it disagrees, and pi runs one more model request; this is the one case besides `consult` where
advice stays in the conversation. On `on-track` or `blocked` the turn ends. At most one review per
turn, never after an aborted or failed reply, under a `pause`d or `stop`ped budget, or for a
reply that calls tools. Text views later show the delivered review as
`[MoA before-done review: advice omitted]`, as they do consult results; native views keep it. The
turn's cached advice is dropped once a review is delivered, so the continuation carries the review
alone. In the transcript the message shows as one line; the advice is on the round's card.

**The `consult` tool:** while MoA is on and the preset has `consult.enabled` (and `maxPerTurn` > 0),
the actor gets a `consult` tool with an optional `question` and an optional `effort` (see Effort). It runs the preset's advisors (same
views, roles, trimming and timeouts as a round) on the actor's latest request plus the response
that made the call, with "The acting agent asks: …" added to the advice request, and returns the
framed advice as the tool result. Unlike per-request advice, this result stays in the
conversation. Text views show earlier consult results as `⟨result consult: advice omitted⟩`, so
advisors still never see past advice; native views send the actor's transcript unchanged (to
share its prompt cache), so there they do see it. Every call counts toward `maxPerTurn`, including
failed and aborted ones; after that it returns "consult limit reached for this turn (N)". If every
advisor fails it returns an error. The round is kept in the tool result's `details` (not as a
`moa` entry), and the advisors' usage is reported on the result, so pi's session totals include it.

Consult calls are invisible to triggers: a response whose tool calls are all `consult` is not a
step (so `every_step`/`every_n` do not fire again right after it, and the step's advice is reused),
consult calls and results do not count toward `on_failure` streaks (nor break or reset them), and
consult results do not make cached advice stale. The tool is added on `/moa on`, a preset switch,
`/moa reload` and session restore, and removed on `/moa off`, a preset switch, `/moa reload`, or at
the next run start after a restore turned it off. Each change alters the actor's tool set, which pi
records as a transition in the transcript; providers that cannot express it get a full checkpoint,
which can miss the prompt cache once.

**Cleaning advisor output:** before advice is framed, cached or returned by `consult`, each
advisor's text is cleaned so the actor is less likely to imitate tool-call or transcript syntax.
Text inside code fences (```` ``` ```` or `~~~`, any language, also unclosed) is never changed, so
code samples survive verbatim. Outside fences, these become `[removed tool-call-like text]`
(adjacent ones merged):
- lines starting with the text view's `⟨tool `/`⟨result ` markers or Hermes-style
  `[called tool:`/`[tool result:`;
- line-leading tool-call tags and their blocks (`<function_calls>`, `<invoke name=…>`,
  `<parameter name=…>`, `<tool_call>`, `<tool_use>`, …) and lines starting with tool-call tokens
  (`<|tool_call|>`, `<|python_tag|>`, `<|call|>`, `[TOOL_CALLS]`, …);
- a top-level JSON object that is exactly a tool call: `"type": "tool_use"`/`"function_call"`, or
  only a `name`/`tool` string plus object-valued `arguments`/`input`/`args`/`parameters` (and ids).
  `parameters` holding a JSON Schema (a tool definition) does not count.

A line starting with `[MoA reference context` becomes `[removed framing-like text]`. A reply that
stopped at its output cap (the provider's length stop) gets
`[advice cut off at the advisor's output limit; the ending is missing]` appended and the record
flag `capped`, so the actor never takes a cut-off sentence for the whole advice. The trade-off
favours keeping text: JSON containers that merely include a call (API responses, `tool_calls`
messages, JSON-RPC `tools/call` requests, arrays of calls), tool definitions, objects whose input
is not an object (`{"name": "build", "input": "x"}`), mid-line tag or token mentions, and anything
fenced are kept, so an advisor can still show call syntax in those forms. Each advisor's text is
then capped at 12,000 characters (head and tail). The record marks advisors whose text was changed
(`sanitized`) or cut (`truncated`); the verdict line is read after cleaning.

**Budget** (`budget`, default `{ "sessionUsd": 5, "onExceed": "warn" }`): advisor spend is the sum
of the advisors' reported cost (`usage.cost.total`) over the `moa` round records and `consult`
results on the current session branch, rebuilt on session start and tree navigation and added to
after every round and consult. Interrupted rounds and timed-out or aborted advisors count with the
partial usage pi reports for them. Calls with no reported cost count as $0 and `/moa` says some
costs are unknown. Before a round or consult, once spend ≥ `sessionUsd`:
- `warn`: advisors run anyway; one notice per session.
- `pause`: no new rounds; advice already produced this turn is still reused (it is paid for);
  `consult` returns a non-error "advisor budget reached … consult is paused" result; one notice.
  Raise `sessionUsd` and `/moa reload` to resume.
- `stop`: MoA is turned off (saved in the session like `/moa off`), with a notice; `consult`
  returns a non-error result saying so. `/moa on` works again but notes the limit is reached, and
  the next round turns it off again until the limit is raised.

`sessionUsd: 0` means no limit. `/moa` shows the spend, e.g.
`advisor spend this session: $0.0123 of $5.00 (warn when reached)`.

**Timeouts and aborts:** a timed-out or aborted advisor call has its own abort signal fired, which
ends the provider request in pi; its aborted reply (which carries the usage reported so far) is
awaited for up to a second so that usage is recorded.

**Display:** each round's `moa` entry shows as one line in the transcript, e.g.
`◇ MoA · user_turn · step 2 · 2/2 advisors · revise, on-track · $0.0120 · 4.1s` (the advisor count
turns warning/error coloured when advisors fail, the verdicts are coloured by the most severe,
`synthesis` / `synthesis: nothing to reconcile` / `synthesis failed` when the preset has one,
`cost ?`/`+?` for unreported cost, `interrupted` for aborted rounds). Expanding tool output (pi's
expand toggle, e.g. Ctrl+O) shows each advisor's label (anonymised as recorded), model, role, effort
level, verdict, tokens in/out (with cached input), cost, latency, flags (`retried`, `sanitized`,
`truncated`, `capped`) or error, and its advice as markdown (code blocks highlighted as in pi's own
messages), then the synthesis the same way. `consult` calls show as `consult "question…"` with the same card as the
result (the actor still gets the plain framed advice); calls that ran no round (limit, budget,
unavailable) show their result text. `ui.advice`: `"collapsed"` (default; follows the expand
toggle), `"expanded"` (always), `"hidden"` (no round entries; consult results show the card line
only). The footer status is `moa:<preset> · $<spend>` (spend omitted at $0, `· budget reached` once
`budget.sessionUsd` is reached), cleared when off and not shown with `ui.status: false`. While
advisors run, pi's working message reads `MoA: advisors k/n…` (the latest of any overlapping rounds and
consults; the default returns when the last one ends). Round entries are shown in
interactive mode only: pi's HTML export skips custom entries (consult results are exported with
their card, collapsed and expanded), and print/JSON/RPC modes do not render them.

**One-shot `/moa <prompt>`** (interactive and RPC modes only; print/JSON mode exit before the
turn would run, so it is refused there, as it is during a manual `/compact`): sends `<prompt>` as a user message with MoA for that turn only (all
of its steps, until the next user message), using your selected model as the actor and the
default preset. It never changes the model, the `/moa on` state or anything else saved in the
session (the round's `moa` record is still written). The preset and its models are checked first,
as for `/moa on`; if they are unusable nothing is sent. If the agent is busy, the prompt is queued
as a follow-up (it runs after the current work, as its own turn). Sending is fire-and-forget:
pi reports a failed send itself, and the notice only says the prompt was sent or queued. If MoA is already active (`/moa on`
or a `moa/*` model), it is a normal message with that preset. The turn is recognised by its
message text, so if another extension rewrites the message on input, MoA does not run for it;
the one-shot is dropped when the agent settles or the session changes. The `consult` tool is not
added for a one-shot turn (changing the tool set costs a prompt-cache miss each way).

**Virtual models** (`"virtualModels": true`): every preset gets a selectable model `moa/<preset>`
(`MoA: <preset>` in `/model`). Selecting it turns MoA on with that preset for as long as it is
selected, independent of `/moa on`: the selected model wins, because it names both the preset and
the actor; a `/moa on` state stays saved and applies again once you select a regular model. Each
request is routed (pi virtual models, see pi's `docs/virtual-models.md`) to the preset's `actor`:
- `"provider/id"`: that model; the virtual model offers that model's thinking levels.
- `"current"`: the last regular model you selected before switching to `moa/*` (from pi's
  `model_select`). The choice is stored as router state on the session branch, so it survives
  resume, `/tree` and forks. A regular model selected since the current session started wins;
  otherwise the branch's state is used, then a model selected earlier while pi was running (e.g.
  before `/new` or a session switch), then the model that answered last; with none of these
  the request fails with "no physical model known yet; select a regular model first". It offers
  every thinking level; pi clamps the level to the routed model.
- Tool-call continuations and retries stay on the model and thinking level that handled the turn
  (keeps prompt caches and thinking signatures valid).

While a `moa/*` model is selected, `"current"` advisors, the native view and `view: "auto"` use the
routed model as the actor (with the thinking level the router picked, clamped to that model;
if the actor cannot be resolved, the model that answered last, as the router does), `consult` is available (if the preset allows it), the footer shows
`moa/<preset>` and `/moa` shows the routed actor. Selecting it warns if the preset cannot run its
advisors. A budget `stop` stops the advisors (it cannot unselect the model). Preset names must be
usable model ids (letters, digits, `.`, `_`, `-`) and presets with config issues get no model;
both are reported. Models are re-synced on session start and `/moa reload` (removed when the
preset or `virtualModels` goes away, including models left by the extension instance before a
pi `/reload`; unchanged models are not re-registered). pi restores a session's selected model before extensions
see the session, so at load only the global config is read: a `moa/*` model for a preset defined
only in a project `.pi/moa.json` is not available at that moment and pi falls back to the model
that answered last.

**Prompt caching:** the advice changes every request, so MoA moves the conversation cache marker
(Anthropic `cache_control`, `cache_control` on OpenRouter `anthropic/*` chat completions, Bedrock
`cachePoint`) from the advice block to the last conversation block before it, for the actor's
requests and the advisors' calls (in the native view, off the advisor's instruction message). That
keeps the conversation prefix cacheable; the advice itself is always uncached input. Limits: pi's
cache warmer replays the last request including its advice, so each warm also pays the advice
tokens as uncached input; on Bedrock the cache point is only placed in user messages; the effect
has not yet been measured against MoA off.

## Install

```bash
pi install ./path/to/pi-moa      # or: pi -e ./path/to/pi-moa for one run
```

## Use

| Command | Effect |
|---|---|
| `/moa` | Status: on/off, preset, triggers, advisors, effort, synthesis, advisor spend, config files |
| `/moa on [preset]` | Turn MoA on for this session (default preset if omitted). Validates the preset and its models first. |
| `/moa off` | Turn it off |
| `/moa reload` | Re-read config files; turns MoA off with a warning if the active preset is no longer usable |
| `/moa init` | Write the built-in defaults to the global config file (never overwrites) |
| `/moa <prompt>` | Send `<prompt>` with MoA for that turn only (default preset; queued as a follow-up while busy) |
| `/model moa/<preset>` | With `virtualModels: true`: MoA with that preset while selected (see Virtual models) |

The on/off state is saved in the session and restored on resume, per branch.
The footer shows `moa:<preset>` while on (`moa/<preset>` while a virtual model is selected).

## Config

- Global: `~/.pi/agent/moa.json` (follows `PI_CODING_AGENT_DIR`)
- Project: `.pi/moa.json`, read only in trusted projects; overrides global.

Both deep-merge over the built-in defaults (arrays replace). Each preset merges over the built-in
`solo` preset values, so a preset lists only what differs. See PLAN.md for the full schema.

## Development

```bash
npm install
npm run check   # typecheck + vitest
```

`PI_MOA_DEBUG=1` logs one line per model request (`context_with_system` call), with the MoA on/off
state and preset, to `~/.pi/agent/moa-debug.log`. Set it to a file path to log there instead.
