import {
  type BuiltInTemplateType,
  buildTemplateStrategy,
  type CompiledStrategy,
  type DslError,
  STRATEGY_TEMPLATES,
  type StrategyDefinition,
  type StrategyParams,
  TemplateParamsError,
  tryCompileStrategy,
} from '@ktrade/finance-core';
import type { StrategyType } from '@ktrade/shared';
import { ZodError } from 'zod';

/** A strategy's trading definition in API/DB terms (decimal strings, JSON rule documents). */
export interface DefinitionSpec {
  type: StrategyType;
  parameters?: Record<string, string | number | boolean> | undefined;
  entryRules?: unknown;
  exitRules?: unknown;
  stopLossPct?: string | null | undefined;
  takeProfitPct?: string | null | undefined;
  trailingStopPct?: string | null | undefined;
  cooldownBars?: number | undefined;
}

export type ParamValueType = 'INT' | 'DECIMAL' | 'BOOL' | 'ENUM' | 'STRING';

export interface ResolvedDefinition {
  /** finance-core definition (templates rebuilt from type + parameters, so their exit reasons are exact). */
  definition: StrategyDefinition;
  compiled: CompiledStrategy;
  /** Rule documents to persist (templates: the generated DSL with `$param` references). */
  entryRules: unknown;
  exitRules: unknown;
  /** Resolved parameters (template defaults applied) with their storage type. */
  parameters: { key: string; value: string; valueType: ParamValueType }[];
}

const isBuiltIn = (t: StrategyType): t is BuiltInTemplateType => t !== 'CUSTOM_RULES';
const DEC_RE = /^-?\d+(\.\d+)?$/;

/** DSL / template errors (JSON paths) as a 422 problem with per-path errors (ZodError → ProblemDetailsFilter). */
export function dslErrorsToValidation(errors: readonly DslError[]): ZodError {
  return new ZodError(
    errors.map((e) => ({
      code: 'custom' as const,
      path: [e.path],
      message: `${e.code}: ${e.message}`,
      input: undefined,
    })),
  );
}

function typeOfCustomParam(v: string | number | boolean): ParamValueType {
  if (typeof v === 'boolean') return 'BOOL';
  if (typeof v === 'number') return 'INT';
  return DEC_RE.test(v) ? 'DECIMAL' : 'STRING';
}

/**
 * Validate and compile a definition. Throws a ZodError (→ 422 with JSON paths) when the template parameters,
 * the rule DSL or the overlays are invalid. Nothing here touches the database.
 */
export function resolveDefinition(spec: DefinitionSpec): ResolvedDefinition {
  const overlays = {
    stopLossPct: spec.stopLossPct ?? null,
    takeProfitPct: spec.takeProfitPct ?? null,
    trailingStopPct: spec.trailingStopPct ?? null,
    cooldownBars: spec.cooldownBars ?? 1,
  };
  let definition: StrategyDefinition;
  let parameters: ResolvedDefinition['parameters'];
  if (isBuiltIn(spec.type)) {
    const extra: DslError[] = [];
    if (spec.entryRules !== undefined && spec.entryRules !== null)
      extra.push({
        path: '$.entryRules',
        code: 'UNKNOWN_KEY',
        message: `not allowed for ${spec.type}; use CUSTOM_RULES`,
      });
    if (spec.exitRules !== undefined && spec.exitRules !== null)
      extra.push({
        path: '$.exitRules',
        code: 'UNKNOWN_KEY',
        message: `not allowed for ${spec.type}; use CUSTOM_RULES`,
      });
    if (extra.length > 0) throw dslErrorsToValidation(extra);
    let built: StrategyDefinition;
    try {
      built = buildTemplateStrategy(spec.type, (spec.parameters ?? {}) as StrategyParams);
    } catch (err) {
      if (err instanceof TemplateParamsError) throw dslErrorsToValidation(err.errors);
      throw err;
    }
    definition = { ...built, ...overlays };
    const schema = STRATEGY_TEMPLATES[spec.type].params;
    parameters = Object.entries(built.parameters ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
      valueType: schema.find((p) => p.name === key)?.type ?? typeOfCustomParam(value),
    }));
  } else {
    if (spec.entryRules === undefined || spec.entryRules === null)
      throw dslErrorsToValidation([
        { path: '$.entryRules', code: 'MISSING_FIELD', message: 'CUSTOM_RULES needs entry rules' },
      ]);
    definition = {
      entryRules: spec.entryRules,
      exitRules: spec.exitRules ?? null,
      parameters: spec.parameters ?? {},
      ...overlays,
    };
    parameters = Object.entries(spec.parameters ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
      valueType: typeOfCustomParam(value),
    }));
  }
  const r = tryCompileStrategy(definition);
  if (!r.ok) throw dslErrorsToValidation(r.errors);
  return {
    definition,
    compiled: r.strategy,
    entryRules: definition.entryRules ?? null,
    exitRules: definition.exitRules ?? null,
    parameters,
  };
}

/** Typed parameter values back from `strategy_parameters` rows. */
export function parametersFromRows(
  rows: readonly { key: string; value: string; valueType: string }[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const r of rows) {
    if (r.valueType === 'INT' && /^-?\d+$/.test(r.value)) out[r.key] = Number.parseInt(r.value, 10);
    else if (r.valueType === 'BOOL') out[r.key] = r.value === 'true';
    else out[r.key] = r.value;
  }
  return out;
}

/** Rebuild the API definition of a persisted strategy. */
export function specFromStrategy(s: {
  type: StrategyType;
  entryRules: unknown;
  exitRules: unknown;
  stopLossPct: { toString(): string } | null;
  takeProfitPct: { toString(): string } | null;
  trailingStopPct: { toString(): string } | null;
  cooldownBars: number;
  parameters: readonly { key: string; value: string; valueType: string }[];
}): DefinitionSpec {
  return {
    type: s.type,
    parameters: parametersFromRows(s.parameters),
    ...(s.type === 'CUSTOM_RULES' ? { entryRules: s.entryRules, exitRules: s.exitRules } : {}),
    stopLossPct: s.stopLossPct?.toString() ?? null,
    takeProfitPct: s.takeProfitPct?.toString() ?? null,
    trailingStopPct: s.trailingStopPct?.toString() ?? null,
    cooldownBars: s.cooldownBars,
  };
}

/** Templates as JSON for UI forms (docs/07: built-ins with a parameter schema). */
export function templatesView() {
  const builtIns = Object.values(STRATEGY_TEMPLATES).map((t) => {
    const example = buildTemplateStrategy(
      t.type,
      Object.fromEntries(
        t.params.filter((p) => p.required).map((p) => [p.name, p.type === 'DECIMAL' ? '100' : 1]),
      ),
    );
    return {
      type: t.type,
      label: t.label,
      description: t.description,
      params: t.params.map((p) => ({
        name: p.name,
        type: p.type,
        default: p.default,
        min: p.min === undefined ? null : String(p.min),
        max: p.max === undefined ? null : String(p.max),
        options: p.options ?? null,
        required: p.required,
        description: p.description,
      })),
      paramsJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: t.params.filter((p) => p.required).map((p) => p.name),
        properties: Object.fromEntries(
          t.params.map((p) => [
            p.name,
            p.type === 'INT'
              ? {
                  type: 'integer',
                  minimum: p.min,
                  maximum: p.max,
                  default: p.default,
                  description: p.description,
                }
              : p.type === 'DECIMAL'
                ? {
                    type: 'string',
                    pattern: '^\\d+(\\.\\d+)?$',
                    ...(p.default === null ? {} : { default: p.default }),
                    description: `${p.description} (decimal string, ${String(p.min)}–${String(p.max)})`,
                  }
                : p.type === 'BOOL'
                  ? { type: 'boolean', default: p.default, description: p.description }
                  : { type: 'string', enum: p.options, default: p.default, description: p.description },
          ]),
        ),
      },
      /** The rule DSL this template compiles to (numeric parameters stay as `$param` references). */
      rules: { entryRules: example.entryRules ?? null, exitRules: example.exitRules ?? null },
      overlays: ['stopLossPct', 'takeProfitPct', 'trailingStopPct'],
    };
  });
  return [
    ...builtIns,
    {
      type: 'CUSTOM_RULES' as const,
      label: 'Custom rules',
      description:
        'Build entry/exit rules with the rule DSL (docs/08 §3); `$param` references resolve from parameters.',
      params: [],
      paramsJsonSchema: { type: 'object', additionalProperties: { type: ['string', 'integer', 'boolean'] } },
      rules: null,
      overlays: ['stopLossPct', 'takeProfitPct', 'trailingStopPct'],
    },
  ];
}
