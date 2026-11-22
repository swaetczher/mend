# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/swaetczher/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/swaetczher/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files — in any of four formats: unified diff, SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines an edit names even when the model's whitespace or indentation drifts (three tiers of matching) and changes every file or nothing at all. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input. The working directory is the root of the tree.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `2` usage / no-patch / format / parse error, `1` one or more edits failed, `0` success.

## What it does

- **Unified diffs** — sections, hunks with wrong line numbers (nearest occurrence wins), creates, deletes, renames, `\ No newline at end of file`, CRLF files.
- **SEARCH/REPLACE blocks** — path lines, fenced blocks, creates, single-occurrence rule with `ambiguous` on repeats.
- **V4A patches** — Add / Delete / Update File, `*** Move to:`, `@@` anchors with a cursor, `*** End of File` chunks.
- **JSON edits** — one JSON array or JSON Lines of `create`, `str_replace` and `insert` tool calls.
- **Matching** — three tiers: exact, trailing whitespace ignored, leading and trailing whitespace ignored (with re-indentation at tier 2).
- **Atomicity** — edits apply in order to the tree as earlier edits left it; when any edit fails, no file is written.

Node 22, standard library only. `SPEC.md` in the kit is the whole specification; `runner.ts` hands a trial over to the kit's runner when `MAKEFUN_ENV_URL` is set, and `check.ts` runs the public practice set on your own machine.

---

<sub>Entered on [make.fun](https://make.fun/?ref=q2k92d3s&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
