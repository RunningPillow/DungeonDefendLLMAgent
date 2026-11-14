// Game data for the simulator: read from the database ONCE, then served from memory.
//
// Three documents are needed: skill definitions, talent trees ("Other") and a template character
// whose heroes serve as bodies for simulated teams. They are read in a read-only transaction.
// After that the simulator never touches the database again: thousands of fights run offline,
// and nothing can be written by accident.

import { config, loadGame, type Game } from "./game.js";

const blockedWrite = (operation: string) => () => {
  throw new Error(`The simulator is read-only: the game code tried to ${operation} a document.`);
};

export class GameData {
  /**
   * A stand-in for a Firestore transaction. The game's functions all take a transaction `t` and call
   * `t.get(document)`. This one answers from memory and refuses everything else.
   */
  readonly offlineTransaction = {
    get: async (ref: any) => {
      const snapshot = this.snapshots.get(ref.path);
      if (!snapshot) throw new Error(`The simulator is offline: the game code tried to read ${ref.path}, which was not preloaded.`);
      return snapshot;
    },
    set: blockedWrite("set"),
    update: blockedWrite("update"),
    delete: blockedWrite("delete"),
    create: blockedWrite("create"),
  };

  private constructor(
    readonly game: Game,
    /** Document path -> the snapshot read at startup. `snapshot.data()` builds a fresh object every call. */
    private readonly snapshots: Map<string, any>,
  ) {}

  static async load(): Promise<GameData> {
    const game = loadGame();
    if (!config.templateCharacter) throw new Error("DD_TEMPLATE_CHARACTER is not set (see .env.example).");

    const snapshots = new Map<string, any>();
    await game.admin.firestore().runTransaction(
      async (transaction: any) => {
        // Passes reads through to the database and remembers every document it sees.
        const recorder = {
          get: async (ref: any) => {
            const snapshot = await transaction.get(ref);
            snapshots.set(ref.path, snapshot);
            return snapshot;
          },
          set: blockedWrite("set"),
          update: blockedWrite("update"),
          delete: blockedWrite("delete"),
          create: blockedWrite("create"),
        };
        await game.utils.QuerryForSkillDefinitions(recorder, game.idx.STAGING_ENV);
        await game.idx.OtherMetadata.QuerryData(recorder);
        const character = await game.idx.CharacterDocument.QuerryData(recorder, config.templateCharacter);
        if (!character) throw new Error(`Template character ${config.templateCharacter} does not exist.`);
      },
      { readOnly: true, maxAttempts: 1 },
    );
    return new GameData(game, snapshots);
  }

  /**
   * Picks up changes made in the database since the data was loaded. Asks only for each document's
   * last-change time (a tiny request) and re-reads the documents that changed.
   * Returns the paths of the documents that were re-read.
   */
  async refresh(): Promise<string[]> {
    const loaded = [...this.snapshots.values()];
    // A field mask naming a field that does not exist returns the documents without their content.
    const current: any[] = await this.game.admin.firestore().getAll(...loaded.map((snapshot) => snapshot.ref), { fieldMask: ["simulatorFreshnessCheck"] });

    const changed: string[] = [];
    for (const [index, snapshot] of loaded.entries()) {
      if (current[index].updateTime?.isEqual(snapshot.updateTime)) continue;
      this.snapshots.set(snapshot.ref.path, await snapshot.ref.get());
      changed.push(snapshot.ref.path);
    }
    return changed;
  }

  /** Which set of collections the compiled game reads: "-staging" or "" (production). */
  get environment(): string {
    return this.game.idx.STAGING_ENV || "production";
  }

  /** Fresh copy of all skill, buff and monster definitions. */
  skillDefinitions(): Promise<any> {
    return this.game.utils.QuerryForSkillDefinitions(this.offlineTransaction, this.game.idx.STAGING_ENV);
  }

  /** Fresh copy of the "Other" metadata document; holds the talent trees. */
  otherMetadata(): Promise<any> {
    return this.game.idx.OtherMetadata.QuerryData(this.offlineTransaction);
  }

  /** Fresh copy of the template character. Every simulated team starts from its own copy. */
  templateCharacter(): Promise<any> {
    return this.game.idx.CharacterDocument.QuerryData(this.offlineTransaction, config.templateCharacter);
  }
}
