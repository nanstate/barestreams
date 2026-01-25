export type ScrapeContext = {
	signal: AbortSignal | null;
};

export const shouldAbort = (context: ScrapeContext): boolean =>
	Boolean(context.signal?.aborted);
