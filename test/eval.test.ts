// Tests of the eval's own parts: the questions and the grading. An eval that grades wrongly
// produces confident numbers that mean nothing, so the grader is tested like any other code.
// These tests need no model and no database.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES, LABELS, labelIn, questionFor } from "../src/eval/cases.js";

test("the label is read from the start of the answer", () => {
  assert.equal(labelIn("TYM_B. Tým B vyhrál 100 % soubojů."), "TYM_B");
  assert.equal(labelIn("NEROZHODNUTO: oba týmy vyhrávají zhruba polovinu."), "NEROZHODNUTO");
  assert.equal(labelIn("  **TYM_A** – warlockové vyhráli 95 %."), "TYM_A");
  assert.equal(labelIn("neplatny_tym, talent nejde naučit."), "NEPLATNY_TYM");
});

test("an answer that does not start with a label is not graded as if it did", () => {
  assert.equal(labelIn("Tým B je silnější."), null);
  assert.equal(labelIn("Silnější je TYM_B."), null, "a label later in the sentence does not count");
  assert.equal(labelIn("TYM_BB"), null, "a longer word that merely starts like a label");
  assert.equal(labelIn(""), null);
});

test("every question describes both teams exactly and offers all labels without hinting at the answer", () => {
  for (const evalCase of CASES) {
    const question = questionFor(evalCase);
    for (const label of LABELS) assert.ok(question.includes(label), `${evalCase.id} lists ${label}`);
    for (const hero of [...evalCase.teamA.heroes, ...evalCase.teamB.heroes]) {
      assert.ok(question.includes(hero.class));
      assert.ok(question.includes(`${hero.gear!.rarity} tier ${hero.gear!.tier}`));
      for (const talent of Object.keys(hero.talents ?? {})) assert.ok(question.includes(talent));
    }
    assert.doesNotMatch(question, /checks|expected|správná odpověď/i);
  }
});

test("case ids are unique", () => {
  assert.equal(new Set(CASES.map((evalCase) => evalCase.id)).size, CASES.length);
});
