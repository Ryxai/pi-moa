# pi-moa — Mixture of Models for pi

Status: plan agreed 2026-10-22; steps 1–9 built, step 10 (effort, verdicts, synthesis, before-done review) built 2026-10-26. Build in this folder (rename `mom` → `moa` at build start).
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

*Built (step 9), deviations:* a selected `moa/<preset>` wins over `/moa on` (which stays saved and
applies again after switching to a regular model); a one-shot uses the active preset or
`defaultPreset`. `actor: "current"` resolves, in order, to a regular model selected in this
session (`model_select`: the model itself, or `previousModel` when switching to `moa/*`), the
branch's router state (written on every change), a selection carried over from an earlier
session, and `request.previous`; rounds compute the actor with the same function (pi writes the
route state before the request hook runs). Continuations/retries stay on `previous`/`failed` when
it is the actor. Virtual models are registered at load from the global config (pi restores the
session's selection before `session_start`) and re-synced with the project config on session
start and `/moa reload`. One-shot: the prompt is sent with `sendUserMessage` (`followUp` while
busy) and bound in the hook to the first new turn whose user message text equals it (never the
turn current when sent); it applies to every step of that turn, ends at the next turn,
`agent_settled` or a session change, and does not add `consult`. It is refused in print/JSON mode (pi exits before
the run) and during a manual `/compact` (pi rejects prompts then). Sync also unregisters `moa/*`
models listed by `modelRegistry.getAll()` that an earlier instance left behind (pi `/reload` keeps
the model runtime).

## Per-request flow (`context_with_system`)

1. **Active?** Skip unless MoA is on for this session or a `moa/*` model is selected.
2. **Where are we?** From the transcript: the last real `user` message (turn key = its timestamp + a content hash), the number of
   assistant steps since then, consecutive `toolResult.isError`, and repeated identical tool calls
   (`name + JSON args` fingerprint).
3. **Should advisors run?** Run if any trigger fires: `user_turn` (step 0), `every_step`, `{every_n: N}`
   (step 0 and every Nth), `on_failure` (a streak of N errors in a row or N repeated calls, when it first reaches
   N and at every further N). A step that already had a round (a retry) never runs again. Otherwise reuse cached
   advice for this turn, with the stale note when tool results arrived after the step it was made for. No cache →
   no advice this step. If compaction removes the turn's user message, the turn key becomes the summary and the
   advice is kept, always stale.
4. **Budget check.** If the session spend is over `budget.sessionUsd`, apply `onExceed`: `warn`, `pause`
   (actor alone) or `stop` (turn MoA off).
5. **Build each advisor's view** (see Context).
6. **Run advisors in parallel** with `ctx.modelRegistry.completeSimple`, `toolChoice: "none"`, `ctx.signal`, a
   per-advisor timeout and `maxTokens`. Use `Promise.allSettled`; continue without failed or late advisors.
   Live status shows "MoA: 1/2 advisors…".
7. **Clean the output.** Strip lines that look like tool calls or transcript markers (`[called tool:`,
   `[tool result:`, tool-call-shaped JSON). Cache it as the turn's latest advice, with the
   last run step and the failure streaks it fired on, unless the run was interrupted.
8. **Record** with `pi.appendEntry("moa", …)`: preset, trigger, step, and per advisor the model, role, text,
   usage, cost, latency and error.
9. **Inject** one trailing user message (see Framing) and return the messages.

Separately, a `before_provider_request` hook moves the cache marker off the advice block (see Caching).

*Built (step 7), deviations:* `sessionUsd: 0` means no limit. `pause` skips fresh rounds but still
reuses advice already produced this turn (already paid for); `consult` returns a non-error
"budget reached" result under `pause` and `stop`. Spend counts the `moa` records and `consult`
results' `details` on the branch, interrupted rounds included. Cleaning never touches code fences;
outside them it replaces (with `[removed tool-call-like text]`, not deletion) transcript-marker
lines, line-leading tool-call tags/tokens, framing-header impersonation and top-level JSON objects
that are exactly a tool call (containers and tool definitions are kept), and caps each advisor's
text at 12,000 characters; records flag `sanitized`/`truncated`. Timed-out/aborted calls wait up to 1 s for
pi's aborted reply so its partial usage is recorded.

## The `consult` tool (on demand)

- Registered with `pi.registerTool`; active only while MoA is on and `consult.enabled` is true.
- Input: optional `question`. Runs the preset's advisors on the current transcript plus the question.
- Returns the framed advice as a normal tool result. **This is the one case where advice stays in context**,
  because the actor asked for it.
- Cap of `maxPerTurn` calls; after that the tool returns "consult limit reached".
- Actor guidance, based on Anthropic's advisor guidance: consult before substantive work, when stuck, before
  changing approach, and before declaring done.
- Reports advisor `usage` in its result so pi's session totals include it.
- *Built (step 6):* advisors see the actor's latest request plus the calling response. Text views
  render earlier consult results as `⟨result consult: advice omitted⟩`; native views keep the
  transcript byte-identical (cache sharing), so they are the one place advisors see past advice.
  Consult-only responses are not steps; consult calls/results are ignored by failure streaks and
  staleness. The round goes in the result's `details`, not a `moa` entry.

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
  - Tool results cut to the start and end at `toolResultChars`, as their own user turn (`⟨result name: …⟩`), so
    turns alternate like a real transcript and each step appends messages.
  - Images replaced with a placeholder.
  - Always ends with a user message asking for the advisor's judgement.
  - Rendering only ever appends, so advisor prompt caching works across steps.
- **Trimming to the advisor's `contextWindow`:**
  - Budget is `window × 0.9 − maxTokens`, estimated at characters / 4.
  - Always keep the `pin` items: `task` (the turn's user message: the last real user message, so steering
    starts a new turn), `latestError`, `latestDiff`, plus the last two steps.
  - Drop the oldest middle steps behind `[… N earlier steps omitted …]`.
  - *Built (step 5), deviations:* estimated at 3 characters per token; the reserve is `maxTokens` (8192 when
    unset) plus the thinking budget, capped at half the window. The marker counts messages
    (`[… N earlier messages omitted …]`), one per dropped run (a pin inside the dropped range splits it).
    Cuts are chunked (30% of the budget) so the prefix stays stable for caching; it also changes when a
    pin moves, and every step once the kept messages alone are over budget (largest blocks cut head and
    tail). The last message is always kept; `task` falls back to the compaction summary. Native views are
    not trimmed (also when `native` is forced on a different model).
- *Native view as built (step 5):* the transcript is projected as pi projects the actor's request (forced
  prompt, hidden declarations, `blockImages`). Anthropic invalidates cached messages when `tool_choice` or
  thinking settings change, so `context.nativeToolChoice` (default `"omit"`) sends no tool choice, uses
  only the reply's text, and retries a text-less reply once with `none`; native advisors use the actor's
  thinking level unless set (the default preset no longer sets `thinking: "high"`) and the actor's session
  id. Bedrock never gets `none` (pi drops `toolConfig` for it, which Bedrock rejects with tool history).
  The `"omit"` retry happens only for tool-call replies (`stopReason: "toolUse"`) without text. Native
  calls get pi's `thinkingBudgets` setting. Hidden declarations come from the run-start prompt options
  (pi rebuilds them per step, agent-session.js:543-552, with no extension API for the live set).

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
  - Be concise; lead with what matters most.
  - Open with one line `Verdict: on-track | revise | blocked`.
  - The effort level's length line is appended last (step 10): 120 / 300 / 600 words, or a summary first at `max`.

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
- *Step 10:* with two or more advisors and no synthesis text the header says they wrote independently and may
  conflict; a synthesis that reconciled something is appended as `Synthesis:` with its own note instead.

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
        { "model": "current", "role": "advisor" }
      ],
      "effort": "medium",
      "maxEffort": "max",
      "triggers": ["user_turn", "on_failure"],
      "onFailure": { "consecutiveErrors": 2, "repeatedCalls": 3 },
      "consult": { "enabled": true, "maxPerTurn": 3 },
      "context": {
        "view": "auto",
        "projectInstructions": true,
        "toolResultChars": 4000,
        "pin": ["task", "latestError", "latestDiff"],
        "nativeToolChoice": "omit"
      },
      "framing": { "anonymize": true, "shuffle": true },
      "timeoutMs": 90000
    },
    "council": {
      "advisors": [
        { "model": "openai/gpt-5.6", "role": "planner", "effort": "high" },
        { "model": "current", "role": "critic", "stance": "against" }
      ],
      "synthesis": { "model": "openai/gpt-5.6-mini", "maxTokens": 1024 },
      "triggers": ["user_turn", { "every_n": 3 }, "on_failure", "before_done"]
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
- *Step 10:* `effort`, `maxEffort` and advisor `effort` must be `low|medium|high|max`; `synthesis` takes
  `model` (resolved like an advisor's), `thinking`, `maxTokens`, `prompt`; `before_done` is a trigger name.

## Commands and UI

- `/moa`: status (on/off, preset, triggers, advisor spend this session).
- `/moa on [preset]`, `/moa off`, `/moa <prompt>`, `/moa init`, `/moa reload`.
- **Status line:** `moa:solo · $0.04` (`· budget reached` once over). Live "advisors k/n" during a round
  goes in pi's working message instead (`setWorkingMessage`), which pi already shows while waiting.
- **Entry renderer** for `moa` records: one collapsed card per round. It expands to each advisor's text, with
  model, role, tokens, cost and latency.
- All display code is wrapped so it can never break a turn.
- `ui.advice: "hidden"` hides round entries; `consult` rows cannot be hidden, so they show the card line
  only. Budget-skipped rounds write no record, so there is no card for them; a budget-gated `consult`
  shows its result text.

## Files

```
moa/
  package.json        pi package manifest (extensions entry)
  src/
    index.ts          setup: config, commands, hooks, tool
    config.ts         merge over defaults, preset lookup (schema.ts: types and defaults)
    config-io.ts      config files: load, trust, /moa init
    config-validate.ts  validation
    config-resolve.ts resolve "current" and model refs
    commands.ts       /moa argument parsing and completion
    roles.ts          base rules, built-in roles, prompt assembly, synthesis rules
    effort.ts         effort levels: thinking, output cap, length line, bumps and caps
    verdict.ts        the advisors' verdict line
    review.ts         before-done review: turn-end detection, combined verdict, request text
    state.ts          session on/off and preset
    triggers.ts       turn analysis and trigger evaluation
    advice-cache.ts   per-turn advice cache and stale detection
    view.ts           native and text views, pinning
    trim.ts           text-view trimming to the advisor's window
    text.ts           head/tail truncation
    round.ts          one advisor round and its record
    advisors.ts       parallel calls, timeouts, abort, usage and cost
    sanitize.ts       neutralise tool-call-looking output
    budget.ts         session advisor spend and onExceed
    framing.ts        the actor-facing advice block
    cache.ts          before_provider_request marker fix
    consult.ts        the consult tool (tool-names.ts: its name)
    debug.ts          PI_MOA_DEBUG log
    render.ts         entry and consult renderers, status line, progress text
    virtual.ts        moa/<preset> virtual models: plan, actor resolution, route()
    oneshot.ts        /moa <prompt> turn binding
  test/               vitest unit tests
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
10. **Effort levels, verdicts, synthesis, before-done review** (built; see README for behaviour):
   - `effort` per preset and slot bundles thinking, `maxTokens` and the prompt's length line (the flat
     "400 words" rule is gone); `on_failure`, `before_done` and `consult` run one level up, `consult`
     may request a level, `maxEffort` caps everything; native slots keep the actor's thinking unless
     they set their own `effort`/`thinking` (prompt-cache principle).
   - A length-stopped reply gets a cut-off note and the `capped` flag.
   - Each advisor opens with `Verdict: on-track | revise | blocked`; parsed into the record and shown
     on the card.
   - Optional `synthesis` slot after rounds with two or more answering advisors; replies exactly
     `No reconciliation needed.` when there is nothing to reconcile (dropped), else reconciles in ~150
     words with its own verdict; without it the framing notes the advice is unreconciled.
   - `before_done` trigger: at `turn_end` of a reply without tool calls, advisors review the work; on a
     combined `revise` the advice is appended as a `moa-review` custom message with `continue: true`
     (advice in context, like `consult`); once per turn; text views show it as omitted advice.

## Later

- Skipping trivial prompts.
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
