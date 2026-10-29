// js-yaml.mjs の型（ustx.ts が使う 2 つだけ）
export function load(str: string, opts?: Record<string, unknown>): unknown;
export function dump(obj: unknown, opts?: Record<string, unknown>): string;
