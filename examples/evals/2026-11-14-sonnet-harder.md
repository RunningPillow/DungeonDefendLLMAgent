# Agent evaluation

Engine claude-code, model sonnet, effort medium, at most 8 rounds. 3 run(s) per case, each from scratch.
Models that answered: claude-haiku-5-5, claude-sonnet-5-5.

**Correct: 6 of 6 graded runs.** Wrong: 0. No label: 0. Runs that failed before answering (not graded): 0.

| Case | What it checks | Right answer | Correct | Runs agree | Answers |
|---|---|---|---|---|---|
| close-below | a small difference that stays below the threshold; the agent must not over-claim | NEROZHODNUTO | 3 of 3 | yes | NEROZHODNUTO, NEROZHODNUTO, NEROZHODNUTO |
| close-above | a moderate difference above the threshold, not a sweep; the stronger team is B | TYM_B | 3 of 3 | yes | TYM_B, TYM_B, TYM_B |

Per run, average (lowest to highest), over graded runs:

- rounds: 2.2 (2.0 to 3.0)
- simulated matches: 1.0 (1.0 to 1.0)
- time: 15 (13 to 18) s
- cost at API list prices: $0.018 (0.012 to 0.027). Nothing was charged; the runs used a Claude subscription.

How the right answers were obtained (the simulator alone, no model):

- close-below: 400 fights: A 58 %, B 42 %; A on left 200 / on right 32, B on left 168 / on right 0; time limit 0
- close-above: 400 fights: A 16 %, B 85 %; A on left 62 / on right 0, B on left 200 / on right 138; time limit 0

With 6 graded runs this is a check that the agent works, not a precise accuracy figure: one wrong run moves the result by 17 points.
