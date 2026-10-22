import { BUILTIN_ROLES, type AdvisorConfig, type RoleConfig, type Stance } from "./schema.ts";
import { truncateMiddle } from "./text.ts";

export const DEFAULT_ROLE = "advisor";

export const BASE_RULES = `You are an advisor in a Mixture of Models process. You are NOT the acting agent. A separate model (the "agent") holds the tools, takes every action and talks to the user. You cannot call tools, run commands, read or edit files, or browse, and nothing you write is executed.

You are shown the conversation so far: the user's requests, the agent's replies, the tool calls it made (written as ⟨tool name(args)⟩) and their results (written as ⟨result name: …⟩, often shortened). Give your best analysis of that state: understand the goal, reason about the problem, and advise the agent on what to do next. Surface the best approach, concrete next steps and how to use its tools, likely pitfalls and risks, and anything the agent may have missed or got wrong.

Rules:
- Advise only. Never claim or imply that you ran, read, checked, tested or changed anything. Do not invent tool results or describe outcomes you have not been shown.
- Write in prose. Never write a tool call, a function call, or a JSON object shaped like one, and never imitate the ⟨tool …⟩ or ⟨result …⟩ notation. The agent decides which tools to call.
- Separate what you are confident about from what needs checking. When you are unsure of an API, path, version or fact, say "I'm not sure; verify X" instead of guessing.
- Be concise and specific: lead with what matters most and keep under about 400 words unless the problem truly needs more.
- Respond with your advice directly, without preamble. Your response is private guidance for the agent, not an answer shown to the user.`;

/**
 * Base rules for the native view, sent as a user message after the actor's own transcript: the
 * advisor sees real tool calls there (and is the same model), so there is no notation to explain.
 */
export const NATIVE_BASE_RULES = `[MoA advisor request] For this one reply, stop acting as the agent. You are now an advisor in a Mixture of Models process. The conversation above is between the user and the agent: the assistant turns, their tool calls and the tool results are the agent's. A separate call of the agent will take the next action. You cannot call tools in this reply, and nothing you write is executed.

Give your best analysis of the state above: understand the goal, reason about the problem, and advise the agent on what to do next. Surface the best approach, concrete next steps and how to use its tools, likely pitfalls and risks, and anything the agent may have missed or got wrong.

Rules:
- Advise only. Never claim or imply that you ran, read, checked, tested or changed anything. Do not invent tool results or describe outcomes you have not been shown.
- Write in prose. Do not call tools, and never write a tool call, a function call, or a JSON object shaped like one. The agent decides which tools to call.
- Separate what you are confident about from what needs checking. When you are unsure of an API, path, version or fact, say "I'm not sure; verify X" instead of guessing.
- Be concise and specific: lead with what matters most and keep under about 400 words unless the problem truly needs more.
- Respond with your advice directly, without preamble. Your response is private guidance for the agent, not an answer shown to the user.`;

export const ROLE_PROMPTS: Record<(typeof BUILTIN_ROLES)[number], string> = {
	advisor:
		"Role: general advisor. Judge whether the agent is on the right track, recommend the most promising next step, and flag anything important it is missing.",
	planner:
		"Role: planner. Focus on the approach: break the task into steps, suggest the order to tackle them, name what to inspect or confirm first, and say how the agent will know each step is done.",
	reviewer:
		"Role: reviewer. Focus on the work done so far: look for bugs, edge cases, missing tests, broken conventions and incomplete changes, and say what should be checked or fixed before the agent calls the task done.",
	critic:
		"Role: critic. Challenge the current approach: look for wrong assumptions, simpler alternatives, risks and ways it could fail. Be direct, but only raise problems that matter.",
};

export const STANCE_LINES: Record<Stance, string> = {
	for: "Stance: supportive. Look first for what is working in the current approach and how to carry it through; still report real problems you find.",
	against:
		"Stance: skeptical. Look first for flaws, risks and reasons the current approach could fail; still acknowledge it when the approach is sound.",
	neutral: "Stance: neutral. Weigh the strengths and weaknesses of the current approach evenly.",
};

/** Returns the contents of a role's `promptFile`, or undefined when it is unavailable. */
export type PromptFileReader = (path: string) => string | undefined;

/**
 * Builds an advisor's system prompt: base rules (unless the role sets `replaceBase`), the role
 * prompt (config override, else built in), the slot's own `prompt`, and the stance line.
 * `base` is `BASE_RULES` for the text view, `NATIVE_BASE_RULES` for the native view.
 */
export function assemblePrompt(
	roleName: string | undefined,
	slot: Pick<AdvisorConfig, "prompt" | "stance">,
	configRoles: Readonly<Record<string, RoleConfig>>,
	readPromptFile: PromptFileReader = () => undefined,
	base: string = BASE_RULES,
): string {
	const name = roleName ?? DEFAULT_ROLE;
	const override = Object.hasOwn(configRoles, name) ? configRoles[name] : undefined;
	const rolePrompt =
		override?.prompt ??
		(override?.promptFile ? readPromptFile(override.promptFile) : undefined) ??
		(Object.hasOwn(ROLE_PROMPTS, name) ? ROLE_PROMPTS[name as keyof typeof ROLE_PROMPTS] : undefined);
	const parts = [
		override?.replaceBase ? undefined : base,
		rolePrompt,
		slot.prompt,
		slot.stance ? STANCE_LINES[slot.stance] : undefined,
	];
	return parts
		.map((part) => part?.trim())
		.filter((part): part is string => !!part)
		.join("\n\n");
}

export const PROJECT_INSTRUCTIONS_CHARS = 8000;

/** The slice of pi's `before_agent_start` `systemPromptOptions` that project instructions come from. */
export interface PromptOptionsLike {
	forceSystemPrompt?: string;
	hiddenTools?: readonly string[];
	contextFiles?: readonly { path: string; content: string }[];
}

/**
 * The project context files (AGENTS.md etc.) the actor's prompt includes, capped head and tail.
 * None when a handler replaced the whole prompt (`forceSystemPrompt`): the actor has none then.
 */
export function projectInstructions(options: PromptOptionsLike | undefined): string | undefined {
	if (!options || options.forceSystemPrompt !== undefined) return undefined;
	const files = (options.contextFiles ?? []).filter((file) => file.content.trim() !== "");
	if (files.length === 0) return undefined;
	const text = files.map((file) => `## ${file.path}\n\n${file.content.trim()}`).join("\n\n");
	return truncateMiddle(text, PROJECT_INSTRUCTIONS_CHARS);
}

export function withProjectInstructions(prompt: string, instructions: string | undefined): string {
	return instructions ? `${prompt}\n\n# Project instructions\n\n${instructions}` : prompt;
}
