import { parseSync } from "oxc-parser";
import { HELPERS } from "../define.js";
import { ConfigError } from "../schema.js";

/**
 * Evaluates `hunch.config.ts` as data, never as code. The hosted app reads
 * configs from arbitrary repos, so executing them would be remote code
 * execution. Allowed: imports (ignored), `const` bindings, object/array/
 * string/number/boolean/null/regex literals, template strings without
 * expressions, string `+` concatenation, `as`/`satisfies`, and calls to
 * defineConfig/noul/choice/score. Anything else is a config error.
 */
export function evaluateConfigSource(source: string, filename = "hunch.config.ts"): unknown {
  const { program, errors } = parseSync(filename, source, { sourceType: "module" });
  if (errors.length) throw new ConfigError(`${filename}: ${errors[0]!.message}`);

  const scope = new Map<string, unknown>();
  const helperAliases = new Map<string, keyof typeof HELPERS>();
  let exported: unknown = undefined;
  let found = false;

  const fail = (node: AnyNode, why: string): never => {
    const line = source.slice(0, node.start ?? 0).split("\n").length;
    throw new ConfigError(`${filename}:${line}: ${why} (hunch configs are evaluated as data, not executed)`);
  };

  const evalNode = (node: AnyNode): unknown => {
    switch (node.type) {
      case "Literal":
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        return node.value;
      case "TemplateLiteral":
        if (node.expressions.length) fail(node, "template literals may not contain ${…}");
        return node.quasis.map((q: AnyNode) => q.value.cooked).join("");
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        return evalNode(node.expression);
      case "UnaryExpression":
        if (node.operator === "-" ) {
          const v = evalNode(node.argument);
          if (typeof v === "number") return -v;
        }
        return fail(node, `unsupported operator ${node.operator}`);
      case "BinaryExpression": {
        if (node.operator !== "+") fail(node, `unsupported operator ${node.operator}`);
        const l = evalNode(node.left);
        const r = evalNode(node.right);
        if (typeof l !== "string" || typeof r !== "string") fail(node, "`+` is only allowed between strings");
        return (l as string) + (r as string);
      }
      case "Identifier":
        if (node.name === "undefined") return undefined;
        if (!scope.has(node.name)) fail(node, `unknown identifier ${node.name}`);
        return scope.get(node.name);
      case "ArrayExpression":
        return node.elements.map((el: AnyNode | null) => {
          if (!el) return fail(node, "array holes are not allowed");
          if (el.type === "SpreadElement") {
            const v = evalNode(el.argument);
            if (!Array.isArray(v)) fail(el, "can only spread arrays into arrays");
            return v;
          }
          return [evalNode(el)];
        }).flat(1);
      case "ObjectExpression": {
        const out: Record<string, unknown> = Object.create(null);
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            const v = evalNode(p.argument);
            if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "can only spread objects into objects");
            Object.assign(out, v);
            continue;
          }
          if (p.computed || p.kind !== "init" || p.method) fail(p, "only plain `key: value` properties are allowed");
          const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : fail(p.key, "unsupported key");
          out[key as string] = p.shorthand ? evalNode(p.key) : evalNode(p.value);
        }
        return out;
      }
      case "CallExpression": {
        if (node.callee.type !== "Identifier") return fail(node, "only calls to defineConfig/noul/choice/score are allowed");
        const helper = helperAliases.get(node.callee.name);
        if (!helper) return fail(node, `call to ${node.callee.name}() is not allowed`);
        const args = node.arguments.map(evalNode);
        return (HELPERS[helper] as (...a: unknown[]) => unknown)(...args);
      }
      default:
        return fail(node, `${node.type} is not allowed`);
    }
  };

  for (const stmt of program.body as AnyNode[]) {
    switch (stmt.type) {
      case "ImportDeclaration":
        if (stmt.importKind === "type") break;
        if (!["@hunch/cli", "@kelbie/hunch"].includes(stmt.source.value)) fail(stmt, "imports must come from @hunch/cli");
        for (const s of stmt.specifiers) {
          if (s.type !== "ImportSpecifier") continue;
          const imported = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          if (Object.hasOwn(HELPERS, imported)) helperAliases.set(s.local.name, imported as keyof typeof HELPERS);
        }
        break;
      case "VariableDeclaration":
        if (stmt.kind !== "const") fail(stmt, "use const bindings");
        for (const d of stmt.declarations) {
          if (d.id.type !== "Identifier" || !d.init) fail(d, "only `const name = value` is allowed");
          scope.set(d.id.name, evalNode(d.init));
        }
        break;
      case "ExportDefaultDeclaration":
        exported = evalNode(stmt.declaration);
        found = true;
        break;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "EmptyStatement":
        break;
      default:
        fail(stmt, `${stmt.type} is not allowed at the top level`);
    }
  }
  if (!found) throw new ConfigError(`${filename}: missing \`export default defineConfig({...})\``);
  return exported;
}

// oxc's ESTree output is untyped JSON for our purposes.
// biome-ignore lint: deliberate
type AnyNode = any;
