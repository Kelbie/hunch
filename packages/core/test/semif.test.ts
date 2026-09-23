import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { answersFrom, bridgePath, defaultBackend, isSetupError, rowsFor, SEMIF_BACKENDS, semifClient, semifSettings, semifModelId, SemifError, type EvaluateRequest, type SemifResult } from "../src/index.js";

const QUESTIONS: EvaluateRequest["questions"] = {
  swallowed: { type: "noul", instructions: "Does the change swallow a failure?" },
  spelled: { type: "noul", instructions: "Is the rule broken?", criteria: { true: "It is broken.", false: "It is followed." } },
  retry: { type: "choice", instructions: "Classify the retry.", criteria: { stable: "Same key.", duplicate: "New key.", "not-applicable": "No retry." } },
  depth: { type: "score", instructions: "How much does the caller coordinate?", criteria: ["All of it.", "Most of it.", "Some of it.", "None of it."] },
};
const STATE = { file: "src/pay.ts", hunk: "+ await charge();" };

test("each question becomes one SemIf row of described options", () => {
  const rows = rowsFor({ state: STATE, questions: QUESTIONS });
  expect(rows.map((r) => r.id)).toEqual(["swallowed", "spelled", "retry", "depth"]);
  // Every row carries the same state, which is what SemIf's shared scoring prefills once.
  expect(rows.every((r) => r.state === STATE)).toBe(true);
  // A noul with no criteria still needs two sentences: SemIf reads descriptions, not option ids.
  expect(rows[0]!.options.map((o) => o.id)).toEqual(["true", "false"]);
  expect(rows[0]!.options.every((o) => o.description.length > 3)).toBe(true);
  expect(rows[1]!.options).toEqual([{ id: "true", description: "It is broken." }, { id: "false", description: "It is followed." }]);
  expect(rows[2]!.options).toEqual([
    { id: "stable", description: "Same key." }, { id: "duplicate", description: "New key." }, { id: "not-applicable", description: "No retry." },
  ]);
  // Score levels keep their order, and their ids are the level numbers a rule's thresholds use.
  expect(rows[3]!.options.map((o) => o.id)).toEqual(["0", "1", "2", "3"]);
  expect(rows[3]!.options[3]!.description).toBe("None of it.");
});

test("a question with more options than SemIf has answer slots is refused, not truncated", () => {
  const criteria = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`o${i}`, `Option ${i}.`]));
  expect(() => rowsFor({ state: STATE, questions: { big: { type: "choice", instructions: "Pick.", criteria } } }))
    .toThrow(/at most 16/);
});

const result = (id: string, options: string[], probabilities: number[]): SemifResult => ({ id, option_ids: options, probabilities });

test("SemIf's option probabilities are read as the three answers a rule is written against", () => {
  const answers = answersFrom({ questions: QUESTIONS }, [
    result("swallowed", ["true", "false"], [0.91, 0.09]),
    result("retry", ["stable", "duplicate", "not-applicable"], [0.2, 0.7, 0.1]),
    result("depth", ["0", "1", "2", "3"], [0.5, 0.5, 0, 0]),
  ]);
  expect(answers.swallowed).toEqual({ type: "noul", p: 0.91 });
  expect(answers.retry?.type === "choice" && answers.retry.choice).toBe("duplicate");
  // A score is the expected level, so a model split between two neighbours lands between them
  // instead of collapsing onto one and hiding the disagreement from `reportBelow`.
  expect(answers.depth?.type === "score" && answers.depth.score).toBeCloseTo(0.5, 10);
  // Confidence is computed here for every provider, so `minConfidence` means one thing everywhere.
  expect(answers.retry?.type === "choice" && answers.retry.confidence).toBeCloseTo((0.7 - 1 / 3) / (1 - 1 / 3), 10);
});

test("a distribution that does not match its options is a broken contract, not a low score", () => {
  expect(() => answersFrom({ questions: QUESTIONS }, [result("swallowed", ["true", "false"], [1])])).toThrow(SemifError);
  expect(() => answersFrom({ questions: QUESTIONS }, [result("nobody-asked", ["true", "false"], [0.5, 0.5])])).toThrow(SemifError);
});

/** A bridge that speaks the protocol without loading anything, so the transport can be tested. */
function fakeBridge(body: string) {
  return (): ChildProcessWithoutNullStreams => spawn(process.execPath, ["-e", `
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    ${body}
  `], { stdio: ["pipe", "pipe", "pipe"] });
}

/** The likeliest option first, so every answer shape has something definite to read. */
const ANSWERING = `
  send({ ready: true, model: { source: "fake" } });
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\\n"); nl >= 0; nl = buffer.indexOf("\\n")) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      send({ id: request.id, results: request.rows.map((row) => {
        const rest = (1 - 0.7) / (row.options.length - 1);
        return { id: row.id, option_ids: row.options.map((o) => o.id),
          probabilities: row.options.map((_, i) => (i === 0 ? 0.7 : rest)), input_tokens: 11 };
      }) });
    }
  });
`;

const settings = () => semifSettings({}, { SEMIF_BRIDGE: "unused-by-the-fake" });

test("one process answers many requests, and each answer goes back to the request that asked it", async () => {
  const client = semifClient(settings(), fakeBridge(ANSWERING));
  const first = client.evaluate({ model: "ignored", state: STATE, questions: QUESTIONS });
  const second = client.evaluate({ model: "ignored", state: { file: "other.ts", hunk: "+x" }, questions: { swallowed: QUESTIONS.swallowed! } });
  const [a, b] = await Promise.all([first, second]);
  expect(Object.keys(a.answers).sort()).toEqual(["depth", "retry", "spelled", "swallowed"]);
  expect(Object.keys(b.answers)).toEqual(["swallowed"]);
  expect(a.answers.swallowed).toEqual({ type: "noul", p: 0.7 });
  expect(a.usage.inputTokens).toBe(44);
  expect(a.modelId).toContain("semif:");
});

test("an unanswered question is an incomplete answer set, never a rule that passed", async () => {
  const client = semifClient(settings(), fakeBridge(`
    send({ ready: true, model: {} });
    process.stdin.on("data", (chunk) => {
      const request = JSON.parse(String(chunk));
      send({ id: request.id, results: [{ id: request.rows[0].id, option_ids: ["true", "false"], probabilities: [0.5, 0.5] }] });
    });
  `));
  await expect(client.evaluate({ model: "m", state: STATE, questions: QUESTIONS })).rejects.toThrow(/incomplete/i);
});

test("a request SemIf could not score fails that request and leaves the model loaded", async () => {
  const client = semifClient(settings(), fakeBridge(`
    send({ ready: true, model: {} });
    let n = 0;
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\\n"); nl >= 0; nl = buffer.indexOf("\\n")) {
        const request = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
        if (++n === 1) send({ id: request.id, error: "ValueError: 41000 input tokens exceed limit 32768" });
        else send({ id: request.id, results: request.rows.map((row) => ({ id: row.id, option_ids: ["true", "false"], probabilities: [0.8, 0.2] })) });
      }
    });
  `));
  const one = { swallowed: QUESTIONS.swallowed! };
  await expect(client.evaluate({ model: "m", state: STATE, questions: one })).rejects.toThrow(/exceed limit/);
  // The next request is answered: a prompt that was too long says nothing about the install.
  expect((await client.evaluate({ model: "m", state: STATE, questions: one })).answers.swallowed).toEqual({ type: "noul", p: 0.8 });
});

test("a SemIf that cannot start is a setup failure, so a run stops instead of repeating it", async () => {
  const client = semifClient(settings(), fakeBridge(`
    process.stderr.write("ModuleNotFoundError: No module named 'torch'\\n");
    send({ error: "ModuleNotFoundError: No module named 'torch'" });
    process.exit(1);
  `));
  const failure = client.evaluate({ model: "m", state: STATE, questions: QUESTIONS }).then(() => null, (e: Error) => e);
  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain("torch");
  expect(isSetupError(error)).toBe(true);
});

test("closing the client ends the model, so a finished command does not hold the terminal", async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const client = semifClient(settings(), (() => (child = fakeBridge(ANSWERING)())) as never);
  await client.evaluate({ model: "m", state: STATE, questions: { swallowed: QUESTIONS.swallowed! } });
  // A loaded model keeps a process and its pipes alive; nothing else would let the command end.
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  client.close();
  expect(await exited).toBe(0);
});

test("closing a client that was never asked anything starts no model", () => {
  let spawned = 0;
  const client = semifClient(settings(), (() => { spawned++; return fakeBridge(ANSWERING)(); }) as never);
  client.close();
  expect(spawned).toBe(0);
});

test("the bridge SemIf is run through ships with the package and is the file Hunch documents", () => {
  const path = bridgePath({});
  expect(existsSync(path)).toBe(true);
  const source = readFileSync(path, "utf8");
  // It must stay a transport: every decision is scored by SemIf's own published functions.
  expect(source).toContain("from semif_phase1 import");
  expect(semifModelId(semifSettings({ model: "Qwen/Qwen3.5-4B", mode: "shared" }, {}))).toContain("Qwen/Qwen3.5-4B");
});

test("a repository fixes the model, and a machine that cannot run it says so", () => {
  const fromConfig = semifSettings({ model: "local/model", revision: "abc", backend: "torch", maxTokens: 8000 }, {});
  expect(fromConfig).toMatchObject({ model: "local/model", revision: "abc", backend: "torch", maxTokens: 8000, mode: "direct", python: "python3" });
  const machine = semifSettings({ model: "local/model", backend: "torch" }, { SEMIF_BACKEND: "mlx", SEMIF_PYTHON: "/venv/bin/python" });
  expect(machine).toMatchObject({ model: "local/model", backend: "mlx", python: "/venv/bin/python" });
  expect(() => semifSettings({}, { SEMIF_MODE: "guess" })).toThrow(/SEMIF_MODE/);
});

test("Apple Silicon runs SemIf on MLX, because PyTorch there loads for minutes before answering", () => {
  expect(defaultBackend("darwin", "arm64")).toBe("mlx");
  expect(defaultBackend("darwin", "x64")).toBe("torch");
  expect(defaultBackend("linux", "x64")).toBe("torch");
  expect(defaultBackend("win32", "x64")).toBe("torch");
  // A config or a machine that names one is obeyed; the default only fills a gap.
  expect(semifSettings({ backend: "torch" }, {}).backend).toBe("torch");
  expect(semifSettings({}, { SEMIF_BACKEND: "llamacpp" }).backend).toBe("llamacpp");
});

test("every backend names the runtime it needs, so an install can be checked before it is recorded", () => {
  // Recording a backend whose runtime is absent is the trap: SemIf only says so at model load.
  expect(SEMIF_BACKENDS.mlx).toMatchObject({ module: "mlx.core", extra: "mlx" });
  expect(SEMIF_BACKENDS.llamacpp).toMatchObject({ module: "llama_cpp", extra: "llamacpp" });
  // PyTorch is SemIf's base dependency, so it has no extra to add.
  expect(SEMIF_BACKENDS.torch.extra).toBeUndefined();
  expect(Object.keys(SEMIF_BACKENDS).sort()).toEqual(["llamacpp", "mlx", "torch"]);
});
