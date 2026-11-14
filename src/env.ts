// Loads settings from the .env file in the project folder (see .env.example).

import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch {
  // no .env file: rely on real environment variables
}
