import { BadRequestError } from "../types.js";

export type ParsedStremioId = {
	baseId: string;
	season?: number;
	episode?: number;
};

const baseIdRegex = /^tt\d+$/;

export const parseStremioId = (id: string): ParsedStremioId => {
	const parts = id.split(":");

	if (parts.length === 1) {
		const baseId = parts[0];
		if (!baseIdRegex.test(baseId)) {
			throw new BadRequestError("Invalid base id");
		}
		return { baseId };
	}

	if (parts.length !== 3) {
		throw new BadRequestError("Invalid id segment count");
	}

	const [baseId, seasonStr, episodeStr] = parts;
	if (!baseIdRegex.test(baseId)) {
		throw new BadRequestError("Invalid base id");
	}

	const season = Number(seasonStr);
	const episode = Number(episodeStr);

	if (!Number.isInteger(season) || season <= 0) {
		throw new BadRequestError("Invalid season");
	}
	if (!Number.isInteger(episode) || episode <= 0) {
		throw new BadRequestError("Invalid episode");
	}

	return { baseId, season, episode };
};
