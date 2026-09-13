# Reliability journey corpus

`corpus.json` is a small, anonymized set of representative `/flow` journeys. It
is validated by `tests/bench.test.ts` and intentionally contains at least three
journeys for each priority ecosystem: Inditex, Prensa Ibérica, and
OpenReferences.

To add a journey, use the `JourneyRecordSchema` from `src/core/bench.ts`, avoid
customer data, list the files a correct plan should target, and provide commands
that prove the behavior. Run `bun test tests/bench.test.ts` afterwards.

Generate a report from a captured flow:

```sh
bun scripts/bench-report.ts --journey J01 --metrics /path/flow-metrics.json --events /path/events.jsonl --one-shot
```

The command writes JSON to stdout. Redirect it into `bench/baselines/` when the
run is a meaningful baseline. A stored baseline is observational, not proof that
the journey was executed by a model.

## Completion gate

- A zero-journey report is only a schema placeholder and cannot be used to claim an improvement.
- Baseline and post-change runs must use the same corpus plus equivalent model/provider conditions.
- Keep the raw Flow metrics and `events.jsonl` files that support each classified outcome.
- Do not substitute unit tests for model-driven execution.

The current missing-input record is documented in
`baselines/2026-09-after.md`. Create `baselines/2026-09-after.json` only after
the real corpus runs exist.
