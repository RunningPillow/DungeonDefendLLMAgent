// Loads the game's own server code so the simulator runs the REAL combat, not a copy of it.
//
// Dungeon Defend's backend is a Firebase Functions project (TypeScript compiled to lib/*.js).
// We load those compiled files straight from the game's folder. Whenever the game's combat
// changes and is recompiled, the simulator picks the change up automatically.

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../env.js";

export const config = {
  functionsDir: path.resolve(repoRoot, process.env.DD_FUNCTIONS_DIR ?? "../DungeonDefend/FirebaseFunctions/functions"),
  firebaseProject: process.env.DD_FIREBASE_PROJECT ?? "",
  templateCharacter: process.env.DD_TEMPLATE_CHARACTER ?? "",
};

/** The game's modules. They are plain JavaScript without type declarations, hence `any`. */
export interface Game {
  /** index.js: CharacterDocument, CharacterHero, OtherMetadata, STAGING_ENV */
  idx: any;
  /** encounter.js: EncounterDocument, joinCharacterToEncounter, ENCOUNTER_CONTEXT */
  enc: any;
  /** worldMap.js: runTimedAutobattle (the function that computes a whole fight) */
  wm: any;
  /** utils.js: QuerryForSkillDefinitions */
  utils: any;
  /** talents.js: talent tree helpers */
  talents: any;
  /** equip.js: generateEquip (the item generator behind the anvil) */
  equip: any;
  /** firebase-admin, the same instance the game code uses */
  admin: any;
}

let game: Game | undefined;
let gameLoadedAt = 0;

export function loadGame(): Game {
  if (game) return game;

  if (!existsSync(path.join(config.functionsDir, "lib/index.js")))
    throw new Error(`Game code not found in ${config.functionsDir}. Set DD_FUNCTIONS_DIR in .env and compile the game (tsc) first.`);
  if (!config.firebaseProject) throw new Error("DD_FIREBASE_PROJECT is not set (see .env.example).");

  process.env.GCLOUD_PROJECT ??= config.firebaseProject;
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??= findCredentials();

  // The game logs every hit to the console. A single fight would print thousands of lines,
  // and later the MCP server needs stdout to stay clean. Our own output uses process.stdout directly.
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};

  const gameRequire = createRequire(path.join(config.functionsDir, "package.json"));
  game = {
    idx: gameRequire("./lib/index.js"),
    enc: gameRequire("./lib/encounter.js"),
    wm: gameRequire("./lib/worldMap.js"),
    utils: gameRequire("./lib/utils.js"),
    talents: gameRequire("./lib/talents.js"),
    equip: gameRequire("./lib/equip.js"),
    admin: gameRequire("firebase-admin"),
  };
  gameLoadedAt = Date.now();
  return game;
}

/**
 * True if the game was recompiled after this process loaded it. A long-running process (the MCP
 * server) keeps the code it loaded at start, so it has to be restarted to pick up the new build.
 */
export function gameCodeChangedSinceLoad(): boolean {
  if (!game) return false;
  const lib = path.join(config.functionsDir, "lib");
  return readdirSync(lib).some((name) => name.endsWith(".js") && statSync(path.join(lib, name)).mtimeMs > gameLoadedAt);
}

function findCredentials(): string {
  const dir = path.join(os.homedir(), ".config/firebase");
  const candidates = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith("_application_default_credentials.json")) : [];
  if (candidates.length !== 1)
    throw new Error(`Expected exactly one Firebase credentials file in ${dir}, found ${candidates.length}. Set GOOGLE_APPLICATION_CREDENTIALS in .env.`);
  return path.join(dir, candidates[0]!);
}
