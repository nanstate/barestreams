export const logScraperWarning = (
	scraper: string,
	message: string,
	details?: Record<string, unknown>,
): void => {
	const suffix = details ? ` ${JSON.stringify(details)}` : "";
	console.warn(`[scraper] ${scraper} ${message}${suffix}`);
};
