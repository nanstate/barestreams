export class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadRequestError";
	}
}

export type Stream = {
	name?: string;
	description?: string;
	url?: string;
	infoHash?: string;
	fileIdx?: number;
	sources?: string[];
	behaviorHints?: {
		countryWhitelist?: string[];
		notWebReady?: boolean;
		bingeGroup?: string;
		proxyHeaders?: {
			request?: Record<string, string>;
			response?: Record<string, string>;
		};
		videoHash?: string;
		videoSize?: number;
		filename?: string;
	};
	seeders?: number;
};

export type StreamResponse = {
	streams: Stream[];
};
