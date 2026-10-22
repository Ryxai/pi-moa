# pi-moa

Mixture of Models for the [pi](https://pi.dev) coding agent. Before your model (the "actor") answers,
1–3 advisor models look at the conversation and give advice that the actor sees for that one request only.
The design is in [PLAN.md](PLAN.md).

**Status: early.** Config, `/moa on|off` and session state work. While on, the preset's advisors
run when one of its triggers fires, with a text view of the transcript; their advice is added to
that request only, and each fresh round is saved as a `moa` session entry with its trigger.

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

The `consult` tool, the advice renderer, `moa/<preset>` virtual models and one-shot `/moa <prompt>`
are planned.

**Prompt caching:** the advice changes every request, so MoA moves the conversation cache marker
(Anthropic `cache_control`, `cache_control` on OpenRouter `anthropic/*` chat completions, Bedrock
`cachePoint`) from the advice block to the last conversation block before it, for the actor's
requests and the advisors' calls. That keeps the conversation prefix cacheable; the advice itself is
always uncached input. Advisors use their own per-slot provider session id (stable OpenAI
`prompt_cache_key`). Limits: pi's cache warmer replays the last request including its advice, so
each warm also pays the advice tokens as uncached input; on Bedrock the cache point is only placed
in user messages; the effect has not yet been measured against MoA off.

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
