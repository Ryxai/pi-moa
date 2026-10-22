# pi-moa

Mixture of Models for the [pi](https://pi.dev) coding agent. Before your model (the "actor") answers,
1–3 advisor models look at the conversation and give advice that the actor sees for that one request only.
The design is in [PLAN.md](PLAN.md).

**Status: early.** Config, `/moa on|off` and session state work. While on, the preset's advisors
run when one of its triggers fires; their advice is added to that request only, and each fresh
round is saved as a `moa` session entry with its trigger.

**What advisors see** (`context.view`, default `"auto"`):
- `native` (auto: the advisor is the actor's model, e.g. `"current"`): the actor's own request —
  system prompt, tools, transcript and same-model thinking, projected as pi projects it (a prompt
  forced by a `before_agent_start` handler, hidden tool declarations, `images.blockImages`) —
  plus one trailing user message with the advisor's instructions. It uses the actor's thinking
  level unless the advisor sets `thinking`, and the actor's session id, so it can reuse the actor's
  prompt cache. `context.nativeToolChoice` (default `"omit"`) sends no tool choice, which keeps
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
  Text advisors use their own thinking setting (none when unset) and a per-slot session id.
- **Trimming** (text view, when the advisor model's `contextWindow` is known): the view is kept
  under `contextWindow × 0.9 − reserve` tokens, estimated at 3 characters per token; the reserve
  is `maxTokens` (8192 when unset) plus the thinking budget for the advisor's `thinking` level,
  capped at half the window. Over that, the oldest messages are replaced by
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
  when a streak first reaches N, and again at every further N.

On steps where nothing fires, the turn's latest advice is reused, with a note that it predates the
newest tool results; with no advice yet this turn, the request goes out without any. A retried
request for a step that already had a round reuses it instead of calling the advisors again, and
interrupted rounds are discarded. If a round cannot run, the turn's earlier advice is used. If
compaction summarises away the turn's user message mid-turn, the turn's advice is kept and always
marked stale; `on_failure` and `every_step` keep working, and `every_n` counts steps from the
summary.

**The `consult` tool:** while MoA is on and the preset has `consult.enabled` (and `maxPerTurn` > 0),
the actor gets a `consult` tool with an optional `question`. It runs the preset's advisors (same
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

The advice renderer, `moa/<preset>` virtual models and one-shot `/moa <prompt>` are planned.

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
| `/moa` | Status: on/off, preset, triggers, advisors, config files |
| `/moa on [preset]` | Turn MoA on for this session (default preset if omitted). Validates the preset and its models first. |
| `/moa off` | Turn it off |
| `/moa reload` | Re-read config files; turns MoA off with a warning if the active preset is no longer usable |
| `/moa init` | Write the built-in defaults to the global config file (never overwrites) |
| `/moa <prompt>` | One-shot turn — planned |

The on/off state is saved in the session and restored on resume, per branch.
The footer shows `moa:<preset>` while on.

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
