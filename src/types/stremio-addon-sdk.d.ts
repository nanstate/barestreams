declare module "stremio-addon-sdk" {
	export type StreamHandlerArgs = {
		type: string;
		id: string;
	};

	export type AddonInterface = {
		manifest: unknown;
		get(resource: string, type: string, id: string): Promise<unknown>;
	};

	export type AddonBuilder = {
		defineStreamHandler(
			handler: (args: StreamHandlerArgs) => unknown,
		): void;
		getInterface(): AddonInterface;
	};

	export const addonBuilder: {
		new (manifest: unknown): AddonBuilder;
		(manifest: unknown): AddonBuilder;
	};
}
