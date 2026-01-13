import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, rename, open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

type DatasetDescriptor = {
  gz: string;
  tsv: string;
};

export type TitleBasics = {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  isAdult: boolean;
  startYear: number | null;
  endYear: number | null;
  runtimeMinutes: number | null;
  genres: string[];
};

const IMDB_BASE_URL = "https://datasets.imdbws.com";
const DATASET_DIR = path.resolve(process.cwd(), "data", "imdb");
const STALE_MS = 24 * 60 * 60 * 1000;
const BUFFER_SIZE = 64 * 1024;

const DATASETS: DatasetDescriptor[] = [{ gz: "title.basics.tsv.gz", tsv: "title.basics.tsv" }];

const refreshes = new Map<string, Promise<void>>();
const titleBasicsCache = new Map<string, TitleBasics | null>();

const datasetPath = (tsv: string): string => path.join(DATASET_DIR, tsv);

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const isStale = async (filePath: string): Promise<boolean> => {
  try {
    const info = await stat(filePath);
    return Date.now() - info.mtimeMs > STALE_MS;
  } catch {
    return true;
  }
};

const downloadFile = async (url: string, destination: string): Promise<void> => {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  const body = response.body as unknown as WebReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(body), createWriteStream(destination));
};

const extractGzip = async (source: string, destination: string): Promise<void> => {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(destination));
};

const downloadAndExtract = async (descriptor: DatasetDescriptor): Promise<void> => {
  const gzUrl = `${IMDB_BASE_URL}/${descriptor.gz}`;
  const gzPath = path.join(DATASET_DIR, `${descriptor.tsv}.gz.download`);
  const tmpTsvPath = path.join(DATASET_DIR, `${descriptor.tsv}.tmp`);
  const finalPath = datasetPath(descriptor.tsv);

  await downloadFile(gzUrl, gzPath);
  await extractGzip(gzPath, tmpTsvPath);
  await rm(gzPath, { force: true });
  await rm(finalPath, { force: true });
  await rename(tmpTsvPath, finalPath);
};

const refreshDataset = async (descriptor: DatasetDescriptor): Promise<void> => {
  const existing = refreshes.get(descriptor.tsv);
  if (existing) {
    await existing;
    return;
  }

  const task = (async () => {
    try {
      await downloadAndExtract(descriptor);
    } finally {
      refreshes.delete(descriptor.tsv);
    }
  })();

  refreshes.set(descriptor.tsv, task);
  await task;
};

export const ensureImdbDatasets = async (): Promise<void> => {
  await mkdir(DATASET_DIR, { recursive: true });

  for (const descriptor of DATASETS) {
    const tsvPath = datasetPath(descriptor.tsv);
    const exists = await fileExists(tsvPath);
    if (!exists) {
      await refreshDataset(descriptor);
      continue;
    }

    if (await isStale(tsvPath)) {
      setImmediate(() => {
        refreshDataset(descriptor).catch((err) => {
          console.error(`Failed to refresh ${descriptor.tsv}:`, err);
        });
      });
    }
  }
};

const findLineStart = async (handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<number> => {
  let cursor = offset;
  const buffer = Buffer.alloc(BUFFER_SIZE);

  while (cursor > 0) {
    const readStart = Math.max(0, cursor - BUFFER_SIZE);
    const length = cursor - readStart;
    const { bytesRead } = await handle.read(buffer, 0, length, readStart);
    if (bytesRead === 0) {
      break;
    }
    const slice = buffer.subarray(0, bytesRead);
    const newlineIndex = slice.lastIndexOf(0x0a);
    if (newlineIndex !== -1) {
      return readStart + newlineIndex + 1;
    }
    cursor = readStart;
  }

  return 0;
};

const readLineForward = async (
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  fileSize: number
): Promise<{ line: string; end: number }> => {
  let cursor = start;
  const chunks: Buffer[] = [];

  while (cursor < fileSize) {
    const buffer = Buffer.alloc(BUFFER_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, BUFFER_SIZE, cursor);
    if (bytesRead === 0) {
      break;
    }
    const slice = buffer.subarray(0, bytesRead);
    const newlineIndex = slice.indexOf(0x0a);
    if (newlineIndex !== -1) {
      chunks.push(slice.subarray(0, newlineIndex));
      cursor += newlineIndex;
      break;
    }
    chunks.push(slice);
    cursor += bytesRead;
  }

  return { line: Buffer.concat(chunks).toString("utf8"), end: cursor };
};

const readLineAtOffset = async (
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  fileSize: number
): Promise<{ line: string; start: number; end: number }> => {
  const boundedOffset = Math.max(0, Math.min(offset, fileSize));
  const start = await findLineStart(handle, boundedOffset);
  const { line, end } = await readLineForward(handle, start, fileSize);
  return { line, start, end };
};

const findLineByTconst = async (filePath: string, tconst: string): Promise<string | null> => {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const header = await readLineAtOffset(handle, 0, size);
    const dataStart = Math.min(header.end + 1, size);

    let low = dataStart;
    let high = size - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const { line, start, end } = await readLineAtOffset(handle, mid, size);
      if (!line) {
        break;
      }
      if (start < dataStart) {
        low = dataStart;
        continue;
      }

      const tabIndex = line.indexOf("\t");
      const key = tabIndex === -1 ? line : line.slice(0, tabIndex);

      if (key === tconst) {
        return line;
      }

      if (key < tconst) {
        low = end + 1;
      } else {
        high = start - 1;
      }
    }
  } finally {
    await handle.close();
  }

  return null;
};

const parseNumber = (value: string): number | null => {
  if (!value || value === "\\N") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseTitleBasics = (line: string): TitleBasics => {
  const [
    tconst,
    titleType,
    primaryTitle,
    originalTitle,
    isAdult,
    startYear,
    endYear,
    runtimeMinutes,
    genres
  ] = line.split("\t");

  return {
    tconst,
    titleType,
    primaryTitle,
    originalTitle,
    isAdult: isAdult === "1",
    startYear: parseNumber(startYear),
    endYear: parseNumber(endYear),
    runtimeMinutes: parseNumber(runtimeMinutes),
    genres: genres && genres !== "\\N" ? genres.split(",") : []
  };
};

export const getTitleBasics = async (tconst: string): Promise<TitleBasics | null> => {
  if (titleBasicsCache.has(tconst)) {
    return titleBasicsCache.get(tconst) ?? null;
  }

  let line: string | null = null;
  try {
    line = await findLineByTconst(datasetPath("title.basics.tsv"), tconst);
  } catch {
    line = null;
  }
  const parsed = line ? parseTitleBasics(line) : null;
  titleBasicsCache.set(tconst, parsed);
  return parsed;
};
