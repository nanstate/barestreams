type MagnetInfo = {
  infoHash: string;
  sources: string[];
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const base32ToHex = (value: string): string | null => {
  const cleaned = value.replace(/=+$/, "").toUpperCase();
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      return null;
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  if (bytes.length === 0) {
    return null;
  }

  return Buffer.from(bytes).toString("hex");
};

const normalizeInfoHash = (value: string): string | null => {
  if (/^[a-f0-9]{40}$/i.test(value)) {
    return value.toLowerCase();
  }
  if (/^[a-z2-7]{32}$/i.test(value)) {
    return base32ToHex(value);
  }
  return null;
};

export const parseMagnet = (magnetUri: string): MagnetInfo | null => {
  let url: URL;
  try {
    url = new URL(magnetUri);
  } catch {
    return null;
  }

  if (url.protocol !== "magnet:") {
    return null;
  }

  const xtParams = url.searchParams.getAll("xt");
  const xt = xtParams.find((value) => value.toLowerCase().startsWith("urn:btih:"));
  if (!xt) {
    return null;
  }
  const rawInfoHash = xt.slice("urn:btih:".length);
  const infoHash = normalizeInfoHash(rawInfoHash);
  if (!infoHash) {
    return null;
  }

  const trackers = url.searchParams.getAll("tr").filter(Boolean);
  const sources = Array.from(
    new Set(
      trackers.map((tracker) => (tracker.startsWith("tracker:") ? tracker : `tracker:${tracker}`))
    )
  );

  return { infoHash, sources };
};
