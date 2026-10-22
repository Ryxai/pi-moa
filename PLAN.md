# pi-moa — Mixture of Models for pi

Status: plan agreed 2026-10-22. Build in this folder (rename `mom` → `moa` at build start).
pi source for reference: `~/Workspaces/Harnesses/pi` (docs: `packages/coding-agent/docs/extensions.md`, `virtual-models.md`).

## Goal

One shared conversation. Before the acting model ("actor") answers, 1–3 advisor models think about the
current state and give advice. Advisors have no tools and never act. Their advice is shown to the actor
for **that one request only**: it is never part of the conversation, and advisors never see past advice.
The actor answers, calls tools and is saved as usual.

## Principles

1. **Advice is transient.** Injected per request via the `context_with_system` hook, never written to context.
   Each round is kept as a `moa` session record (excluded from model context) for display and analysis.
2. **Your model stays your model.** Main activation is a toggle on the current model; `"current"` is the default
   advisor model. `moa/<preset>` virtual models are optional, for presets with a fixed actor.
3. **Advice is untrusted input.** Labelled, anonymised, shuffled, cleaned, and the actor is told to verify with tools.
4. **Don't break the prompt cache.** Advice sits at the tail; the cache marker is kept on the last real block.
5. **Cheap by default.** One advisor, run on new user turns and on failures, plus an on-demand `consult` tool.
6. **Never break a turn.** Advisor failures, timeouts, budget limits and display errors degrade to "actor alone".

## Activation

| How | Actor | Notes |
|---|---|---|
| `/moa on [preset]` / `/moa off` | Your selected model | Main path. State saved per session (`appendEntry`), restored on resume. |
| `/moa <prompt>` | Your selected model | One turn only. Must not change the model or any lasting state. |
| `/model moa/<preset>` | Preset's `actor` | Optional (`virtualModels: true`). `actor: "current"` = last real model, taken from `model_select.previousModel`. |

`"current"` in an advisor slot always means "the actor".

## Per-request flow (`context_with_system`)

1. **Active?** Skip unless MoA is on for this session or a `moa/*` model is selected.
2. **Where are we?** From the transcript: the last real `user` message (turn key = its timestamp), the number of
   assistant steps since then, consecutive `toolResult.isError`, and repeated identical tool calls
   (`name + JSON args` fingerprint).
3. **Should advisors run?** Run if any trigger fires: `user_turn` (step 0), `every_step`, `{every_n: N}`
   (step 0 and every Nth), `on_failure` (N errors in a row or N repeated calls). Otherwise reuse cached advice
   for this turn, with the stale note when tool activity has happened since. No cache → no advice this step.
4. **Budget check.** If the session spend is over `budget.sessionUsd`, apply `onExceed`: `warn`, `pause`
   (actor alone) or `stop` (turn MoA off).
5. **Build each advisor's view** (see Context).
6. **Run advisors in parallel** with `ctx.modelRegistry.completeSimple`, `toolChoice: "none"`, `ctx.signal`, a
   per-advisor timeout and `maxTokens`. Use `Promise.allSettled`; continue without failed or late advisors.
   Live status shows "MoA: 1/2 advisors…".
7. **Clean the output.** Strip lines that look like tool calls or transcript markers (`[called tool:`,
   `[tool result:`, tool-call-shaped JSON). Cache the cleaned advice under (turn key, step), unless the run was
   interrupted.
8. **Record** with `pi.appendEntry("moa", …)`: preset, trigger, step, and per advisor the model, role, text,
   usage, cost, latency and error.
9. **Inject** one trailing user message (see Framing) and return the messages.

Separately, a `before_provider_request` hook moves the cache marker off the advice block (see Caching).

## The `consult` tool (on demand)

- Registered with `pi.registerTool`; active only while MoA is on and `consult.enabled` is true.
- Input: optional `question`. Runs the preset's advisors on the current transcript plus the question.
- Returns the framed advice as a normal tool result. **This is the one case where advice stays in context**,
  because the actor asked for it.
- Cap of `maxPerTurn` calls; after that the tool returns "consult limit reached".
- Actor guidance, based on Anthropic's advisor guidance: consult before substantive work, when stuck, before
  changing approach, and before declaring done.
- Reports advisor `usage` in its result so pi's session totals include it.

## Context (what advisors see)

- `view: "auto"`: `native` when the advisor model equals the actor, otherwise `text`.
- **`native`:** the real transcript (same system prompt and tools) with `toolChoice: "none"`, plus the advisor
  instructions as a trailing user message. This shares the actor's prompt cache and includes project
  instructions automatically.
- **`text`** (Hermes-style):
  - A system prompt made of the advisor base rules, the role, and optionally project instructions
    (`projectInstructions: true` by default).
  - User and assistant text only; thinking dropped.
  - Tool calls rendered as `⟨tool name(args)⟩`. This is a format advisors won't imitate as output.
  - Tool results cut to the start and end at `toolResultChars`, attached to the preceding assistant text.
  - Images replaced with a placeholder.
  - Always ends with a user message asking for the advisor's judgement.
  - Rendering only ever appends, so advisor prompt caching works across steps.
- **Trimming to the advisor's `contextWindow`:**
  - Budget is `window × 0.9 − maxTokens`, estimated at characters / 4.
  - Always keep the `pin` items: `task` (first user message of the turn), `latestError`, `latestDiff`, plus the
    last two steps.
  - Drop the oldest middle steps behind `[… N earlier steps omitted …]`.

## Roles

- **Built in:** `advisor` (general), `planner`, `reviewer`, `critic`.
- **Config:** `roles` overrides a role by name or adds new ones, via `prompt` or `promptFile`. An advisor slot
  can also give its own `prompt`. `stance` can be `for`, `against` or `neutral`; it biases what the advisor
  looks for, not its verdict.
- **Final prompt** = base rules + role prompt + stance line. `replaceBase: true` opts out of the base rules.
- **Base rules:**
  - You advise; you cannot act or run anything.
  - Never claim to have done anything.
  - Never write tool calls or JSON shaped like them.
  - Separate what you are confident about from what needs checking.
  - Be concise; keep under about 400 words unless needed.

## Framing (what the actor sees)

```
[MoA reference context — private, untrusted]
Advice from N advisor(s). It may be wrong. Verify claims with tools before relying on them,
note where advisors disagree, and do not mention advisors in your reply.
<stale note, if reused after tool results>
Advisor A (planner):
…
Advisor B (critic):
…
[Unavailable: 1 advisor (timeout)]
```

- `anonymize`: advisors are labelled A/B rather than by model name.
- `shuffle`: order is randomised.
- If every advisor fails, there is no block; show a UI notice only.

## Caching

- **Actor:** advice is the final user content. pi's Anthropic adapter puts the cache marker on the last
  block (`ai/src/api/anthropic-messages.ts:1529`), which would be the advice, so only the system prompt and
  tools would ever hit.
  - Fix: in `before_provider_request`, for Anthropic-style payloads, move `cache_control` from the advice
    block to the previous real block. Do the same for OpenAI-compatible `cache_control` routes.
  - Automatic-prefix providers (OpenAI, Gemini, DeepSeek) need nothing.
- **Advisors:** native views get the same marker fix. Text views are append-only, so their prefix repeats.
- **Check:** compare `usage.cacheRead` share with MoA on vs off over a multi-step task.

## Config

The global file is `~/.pi/agent/moa.json`. A project file at `.pi/moa.json` overrides it, in trusted projects
only. Presets deep-merge over the built-in defaults, so a preset only lists what differs. With no file, the
built-in `solo` preset is used; `/moa init` writes it out.

```json
{
  "defaultPreset": "solo",
  "roles": {
    "reviewer": { "promptFile": "./roles/reviewer.md" },
    "security": { "prompt": "Focus on injection, auth, secrets, unsafe shell use…" }
  },
  "presets": {
    "solo": {
      "actor": "current",
      "advisors": [
        { "model": "current", "role": "advisor", "thinking": "high", "maxTokens": 2048 }
      ],
      "triggers": ["user_turn", "on_failure"],
      "onFailure": { "consecutiveErrors": 2, "repeatedCalls": 3 },
      "consult": { "enabled": true, "maxPerTurn": 3 },
      "context": {
        "view": "auto",
        "projectInstructions": true,
        "toolResultChars": 4000,
        "pin": ["task", "latestError", "latestDiff"]
      },
      "framing": { "anonymize": true, "shuffle": true },
      "timeoutMs": 90000
    },
    "council": {
      "advisors": [
        { "model": "openai/gpt-5.6", "role": "planner" },
        { "model": "current", "role": "critic", "stance": "against" }
      ],
      "triggers": ["user_turn", { "every_n": 3 }, "on_failure"]
    }
  },
  "budget": { "sessionUsd": 5, "onExceed": "warn" },
  "ui": { "advice": "collapsed", "status": true },
  "virtualModels": true
}
```

**Validation, at load and on `/moa on`:**
- Every model resolves and has credentials (`hasConfiguredAuth`).
- At most 3 advisors per preset.
- No `moa/*` models inside a preset.
- Unknown roles are reported.
- Errors are reported clearly, and the preset is refused rather than failing mid-turn.

## Commands and UI

- `/moa`: status (on/off, preset, triggers, advisor spend this session).
- `/moa on [preset]`, `/moa off`, `/moa <prompt>`, `/moa init`, `/moa reload`.
- **Status line:** `moa:solo · $0.04`, plus live "advisors k/n" during a round.
- **Entry renderer** for `moa` records: one collapsed card per round. It expands to each advisor's text, with
  model, role, tokens, cost and latency.
- All display code is wrapped so it can never break a turn.

## Files

```
moa/
  package.json        pi package manifest (extensions entry)
  index.ts            setup: config, commands, hooks, tool, renderer, optional virtual models
  config.ts           load, merge over defaults, validate; resolve "current"
  roles.ts            base rules, built-in roles, prompt assembly
  state.ts            session on/off and preset; turn position from the transcript
  triggers.ts         trigger evaluation, advice cache, stale detection
  view.ts             native and text views, trimming, pinning
  advisors.ts         parallel calls, timeouts, abort, usage and cost
  sanitize.ts         strip tool-call-looking output
  framing.ts          the actor-facing advice block
  cache.ts            before_provider_request marker fix
  consult.ts          the consult tool
  render.ts           entry renderer and status line
  test/               vitest unit tests (view, triggers, sanitize, framing, config, cache)
```

## Build order (each step ends working and tested)

1. **Skeleton:** package, config loading with defaults, `/moa on|off`, a pass-through hook. Check the hook
   fires once per step.
2. **Advisors in `per_step`:**
   - text view, roles, parallel calls, framing, records;
   - test with a cheap model;
   - confirm advice never appears in later requests (log the `context` output).
3. **Cache marker fix:** compare cached-token share with MoA on vs off on Anthropic.
4. **Triggers:** `user_turn`, `every_n`, `on_failure`, advice cache and stale note.
5. **Native view:** with "current" resolution and trimming and pinning.
6. **`consult` tool:** with the per-turn cap and usage reporting.
7. **Cleaning, budget, timeouts and abort**; interrupted rounds are never cached.
8. **UI:** renderer, status line, live progress.
9. **Optional `moa/<preset>` virtual models** and `/moa <prompt>` one-shot.

## Later

- Synthesis slot.
- Skipping trivial prompts.
- Severity tags.
- `/moa label` (did the advice help?).
- Side-by-side viewer.
- Read-only tools for `consult`.
- Reconciling advisors who disagree.

## Not doing

- Debate between advisors.
- Peer ranking.
- Multiple layers.
- Async watchdog.
- Best-of-N worktrees.
- Learned routing.

## References

- Hermes `agent/moa_loop.py`; key issues #112358, #139568, #135607, #141381, #140424.
- Anthropic advisor tool and "advisor strategy" post.
- Self-MoA (arXiv 2502.00674), MoA (2406.04692), deception robustness (2503.05856).
- Related pi packages: `@estebanforge/pi-mixture-of-agents`, `pi-moa` (gitee), `bpx-consult`, `pi-advisor-flow`.
