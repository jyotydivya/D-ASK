# Capability check evaluation (experimental, off by default)

Generated 2026-11-05T14:33:20.332Z. Every number is computed from the task lists and result files.

## 1. Classifier alone (no model)

### Phase 4 suite (the word lists were written with these in view: not independent)

| Group | n | refused | supported | ambiguous |
|---|---|---|---|---|
| phase4-answerable | 27 | 0 | 25 | 2 |
| phase4-unsupported | 5 | 5 | 0 | 0 |

- **False refusals** (answerable but refused): 0/27 (0%) [0–12]
- **Correct refusals** (impossible and refused): 5/5 (100%) [57–100]

### Phase 5 set (written after the word lists were frozen)

| Group | n | refused | supported | ambiguous |
|---|---|---|---|---|
| paraphrase | 14 | 0 | 8 | 6 |
| multi | 4 | 0 | 2 | 2 |
| trap | 8 | 7 | 0 | 1 |
| ambiguous | 6 | 0 | 0 | 6 |
| unsupported | 12 | 9 | 0 | 3 |
| mixed | 4 | 4 | 0 | 0 |

- **False refusals** (answerable but refused): 7/26 (27%) [14–46]: ct01 "Find out how much RAM I have"; ct02 "Look up the current time"; ct03 "Run a calculation for me: 12*12"; ct04 "Read me the time"; ct06 "Open up the docs folder and list what's inside"; ct07 "Search the agent/runtime folder and list the files"; ct08 "What is the word count of 3*4?"
- **Correct refusals** (impossible and refused): 13/16 (81%) [57–93]
- Impossible requests NOT refused (they go to the planner, and verification still caps them): cu06 "Who won the world cup in 2018?"; cu10 "Tell me a joke"; cu12 "Is it raining outside?"

## 2. Full runs through the runtime, real local model

Measured. Temperature 0, one run per configuration. `refusal correct` counts impossible requests refused; `tools run on impossible` counts impossible requests where a tool was executed anyway.

| Config | n | Answerable served | False refusals | Impossible refused | Tools run on impossible | Incorrect completion claims | Ambiguous claimed completed | Median task time |
|---|---|---|---|---|---|---|---|---|
| p5_0.5b_capOff | 84 | 41/53 (77%) [64–87] | 0/53 (0%) | 0/21 (0%) [0–15] | 21/21 (100%) | 0 | 0/6 | 3.7 s |
| p5_0.5b_capOn | 84 | 34/53 (64%) [51–76] | 7/53 (13%) | 18/21 (86%) [65–95] | 3/21 (14%) | 0 | 0/6 | 3.3 s |
| p5_3b_capOff | 84 | 43/53 (81%) [69–89] | 0/53 (0%) | 10/21 (48%) [28–68] | 11/21 (52%) | 0 | 0/6 | 14.5 s |
| p5_3b_capOn | 84 | 38/53 (72%) [58–82] | 7/53 (13%) | 18/21 (86%) [65–95] | 3/21 (14%) | 0 | 0/6 | 13.1 s |

