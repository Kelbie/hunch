# hunch eval

Measures each rule's precision and recall on labelled diffs, so a threshold or wording change is
judged by numbers rather than one example. Use it before promoting a rule to `error`. Flags:
[cli.md](cli.md#hunch-eval). Output: [examples/eval.md](../examples/eval.md).

## Fixtures

A directory of `.diff` files. Each starts with the rules that **should** fire on it, and may give
a task:

```diff
# expect: payments/retry-safety
# task: Retry failed charges up to three times
diff --git a/src/payments/charge.ts b/src/payments/charge.ts
--- a/src/payments/charge.ts
+++ b/src/payments/charge.ts
@@ -1,3 +1,3 @@
 export async function charge(gateway, order) {
-  return gateway.charge({ amount: order.total, idempotencyKey: order.id });
+  return gateway.charge({ amount: order.total, idempotencyKey: crypto.randomUUID() });
 }
```

A fixture with `# expect:` and nothing after it should fire nothing. Any rule that fires but
wasn't expected counts as a false positive. Write pairs: one diff that should fire and a near miss
that shouldn't (a safe retry, an equivalent assertion). Hunch's own pairs are in
`examples/presets` in the Hunch repository.

## Running it

```sh
npx -y --min-release-age=0 @kelbie/hunch eval fixtures                                      # the repository's rules
npx -y --min-release-age=0 @kelbie/hunch eval fixtures --rule payments/idempotent="…"      # trial a rule without a config
npx -y --min-release-age=0 @kelbie/hunch eval fixtures --reporter json
```

Each fixture is one real review, so eval costs as much as reviewing those diffs. It refuses
to run with a stale `hunch.lock`, and stops at the first fixture whose review is incomplete. A
partial review would make the numbers meaningless.

Text output is a table of `rule, precision, recall, tp, fp, fn`. JSON is
`{ fixtures: [{ file, expected, fired }], rules: [{ rule, precision, recall, tp, fp, fn }] }`.
A rule with no expected and no fired cases shows 1.00 for both. That isn't evidence, so add
fixtures for it.


## Evaluating search rather than review rules

`eval` measures configured review rules on diffs. For `find` window-size and overlap experiments,
the Hunch repository includes a [public pinned-corpus benchmark](https://github.com/Kelbie/hunch/blob/main/benchmarks/search/README.md).
It measures annotated evidence recall, source-reading workload and real provider usage. Its sparse
labels do not establish exhaustive recall, precision, or superiority to an agent using grep.
