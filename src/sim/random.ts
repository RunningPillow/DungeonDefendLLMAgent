// Repeatable randomness.
//
// The game rolls all its dice (crits, dodges, random targets) with JavaScript's Math.random.
// "Random" numbers on a computer come from a formula that turns a starting number, the seed,
// into a long sequence. While a match runs we swap Math.random for our own formula with a known
// seed. The game code does not notice, but its dice now come from our sequence:
// same seed -> same sequence -> the same crits and dodges -> exactly the same fights.

/** Deterministic random number generator (mulberry32): returns numbers in [0, 1) like Math.random. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `action` with the game's dice replaced by a seeded sequence, then puts the previous dice back. */
export function withSeed<T>(seed: number, action: () => T): T {
  const previous = Math.random;
  Math.random = seededRandom(seed);
  try {
    return action();
  } finally {
    Math.random = previous;
  }
}

/** Same as withSeed for actions that take time (a whole match). */
export async function withSeedAsync<T>(seed: number, action: () => Promise<T>): Promise<T> {
  const previous = Math.random;
  Math.random = seededRandom(seed);
  try {
    return await action();
  } finally {
    Math.random = previous;
  }
}

/** Turns a text into a seed, so the same text always gives the same dice. */
export function seedFromText(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0;
  return hash;
}
