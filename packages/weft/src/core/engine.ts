// Barrel re-exporting from src/core/engine/. The Engine class and friends
// now live in engine/index.ts; this barrel keeps the canonical
// `from './engine.ts'` import path working for all 73 existing call
// sites without churn.
export * from './engine/index.ts';
