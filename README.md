# pi-moa

Mixture of Models for the [pi](https://pi.dev) coding agent. Before your model (the "actor") answers,
1–3 advisor models look at the conversation and give advice that the actor sees for that one request only.
The design is in [PLAN.md](PLAN.md).

**Status: early.** Config, `/moa on|off` and session state work. While on, the preset's advisors
run on **every** model request (triggers are not applied yet) with a text view of the transcript;
their advice is added to that request only, and each round is saved as a `moa` session entry.
Triggers, the `consult` tool, the cache-marker fix, the advice renderer, `moa/<preset>` virtual
models and one-shot `/moa <prompt>` are planned.

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
