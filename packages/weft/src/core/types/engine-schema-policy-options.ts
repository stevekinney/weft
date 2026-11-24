/** The schema-policy fields of `EngineOptions`. */
export interface EngineSchemaPolicyOptions {
  /**
   * Whether every registered definition must declare its schemas. Under the
   * default `'optional'`, schemas are metadata a definition may omit, and an
   * omitted one leaves that field empty in the contract, `GET /v1/registry`,
   * `weft codegen` output, and MCP tools. Under `'required'`, registration
   * throws {@link DefinitionSchemaRequiredError}, naming every undeclared
   * schema, when a definition leaves one out. That covers a workflow's input
   * and output, its finalizer's, each declared signal's input, each update's
   * and query's input and output, each `.activities({...})` entry's input and
   * output, and each engine-level activity's input and output, whether passed
   * to `engine.register()`, `Engine.create({ workflows, activities })`, or
   * loaded by `engine.resolveWorkflowSource()`.
   *
   * There is no exemption for a payload-less message or activity: at runtime
   * the engine cannot tell one from a definition whose author forgot the
   * schema, so declare a schema that accepts `undefined`, such as
   * `z.undefined()`. This check runs at registration only; `payloadValidation` runs the schemas at runtime. A dynamic
   * source revision another process already installed is read from the catalog
   * without loading its module, so this process checks it only when it loads
   * that module to run it.
   */
  schemas?: 'optional' | 'required';
  /**
   * Whether the engine validates inbound payloads at runtime against the
   * schemas their definitions declare. Under the default `'none'`, schemas are
   * never run. Under `'inbound'`, the engine runs the declared Standard Schema
   * before it accepts:
   *
   * - a workflow's start input (`engine.start()`, `startOrSignal()`,
   *   `ctx.startChild()`, schedule fires, and retries), against `inputSchema`;
   * - a signal's payload, against the declared signal's `inputSchema`,
   *   including the initial signal `startOrSignal()` writes with a new run;
   * - an update's input, against the declared update's `inputSchema`, before
   *   any `updateValidators` entry runs;
   * - a query's input, against the declared query's `inputSchema`.
   *
   * A rejected payload throws {@link StandardSchemaValidationError}, whose
   * `operation` names the boundary (`weft.workflows.start`,
   * `weft.workflows.signal`, `weft.workflows.update`, or
   * `weft.workflows.query`), and nothing is written. The server answers it as
   * `InvalidParams`. A payload with no declared schema, such as an undeclared
   * signal, passes unchecked; combine with `schemas: 'required'` to rule that
   * out.
   *
   * Validation never transforms a payload: the engine stores and delivers the
   * value the caller sent, not the schema's output, so a coercion or default
   * in the schema does not change what the workflow receives. Every inbound
   * schema must carry a runtime validator; registration rejects a schema that
   * only describes JSON Schema with a `TypeError`.
   *
   * Outputs (a workflow's result, an update's or query's response) and activity
   * inputs and outputs are not validated. A signal to a dynamic-source
   * workflow whose source this process has not loaded is not validated either.
   */
  payloadValidation?: 'none' | 'inbound';
}
