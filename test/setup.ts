type FilePropertyBag = {
	lastModified?: number;
	type?: string;
};

if (typeof (globalThis as { File?: unknown }).File === "undefined") {
	class File {
		name: string;
		lastModified: number;
		type: string;

		constructor(
			_parts: unknown[] = [],
			name = "file",
			options: FilePropertyBag = {},
		) {
			this.name = name;
			this.lastModified = options.lastModified ?? Date.now();
			this.type = options.type ?? "";
		}
	}

	(globalThis as { File: typeof File }).File = File;
}
