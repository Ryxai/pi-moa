/** Keeps the start and end of `text` within about `max` UTF-16 units, never splitting a surrogate pair. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const start = head(text, Math.ceil(max / 2));
	const end = tail(text, max - Math.ceil(max / 2));
	const omitted = text.length - start.length - end.length;
	return `${start}\n[… ${omitted} chars omitted …]\n${end}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function head(text: string, n: number): string {
	const cut = n > 0 && isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;
	return text.slice(0, cut);
}

function tail(text: string, n: number): string {
	if (n <= 0) return "";
	const from = text.length - n;
	return text.slice(isLowSurrogate(text.charCodeAt(from)) ? from + 1 : from);
}
