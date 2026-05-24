/**
 * Shared layer-vocabulary for the workflow loader + validator.
 *
 * Lives in its own module so `load.ts` (loader / merge) and `validate.ts`
 * (issue attribution) can both reference the same union without a circular
 * import. `load.ts` depends on `validate.ts` for `validateWorkflow`, so
 * declaring `ConfigLayer` here keeps the dependency direction strict and
 * eliminates the silent-drift risk of two parallel string-literal unions.
 */

export type ConfigLayer = "built-in" | "user" | "project";
