import type { BunPlugin } from 'bun';
import { dirname } from 'node:path';
import { compile, compileModule, parse } from 'svelte/compiler';
import ts from 'typescript';
import { environmentConfiguration } from './environment-configuration.ts';

/** Svelte compiler output target. */
export type SvelteGenerationTarget = 'client' | 'server';

/** Options controlling the Svelte Bun plugin compiler. */
export type SvelteCompilerPluginOptions = {
  /** Output target. */
  generate?: SvelteGenerationTarget;
  /** Whether to inject compiled CSS. */
  injectCss?: boolean;
  /** Whether to compile in development mode. */
  development?: boolean;
  /** Decides whether a source may contain a style block. */
  allowStyleBlock?: (path: string) => boolean;
  /** Rewrites the source filename used by the compiler. */
  filename?: (path: string) => string;
  /** Transforms generated server output. */
  transformServerOutput?: (input: { code: string; path: string; dev: boolean }) => string;
};

type SvelteCompilerPluginHooks = {
  allowStyleBlock?: ((path: string) => boolean) | undefined;
  filename?: ((path: string) => string) | undefined;
  transformServerOutput?:
    ((input: { code: string; path: string; dev: boolean }) => string) | undefined;
};

/** Source location of a server component boundary call. */
export type ServerComponentBoundary = {
  /** Column containing the call. */
  column: number;
  /** Zero-based call index in the source. */
  index: number;
  /** Line containing the call. */
  line: number;
};

const typeScriptTranspiler = new Bun.Transpiler({ loader: 'ts' });

/** Returns whether Svelte source contains an authored style block. */
export function hasAuthoredStyleBlock(source: string): boolean {
  const ast = parse(source, { modern: true });
  return Boolean(ast.css);
}

function hasModifier(
  node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> },
  kind: ts.SyntaxKind,
): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isServerComponentBoundaryCall(node: ts.CallExpression): boolean {
  const [firstArgument] = node.arguments;
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'component' &&
    node.arguments.length === 1 &&
    firstArgument !== undefined &&
    (ts.isArrowFunction(firstArgument) || ts.isFunctionExpression(firstArgument))
  );
}

function findDefaultComponentFunction(
  sourceFile: ts.SourceFile,
): ts.FunctionDeclaration | undefined {
  let defaultExportName: string | undefined;

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement;
    }

    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      defaultExportName = statement.expression.text;
    }
  }

  if (defaultExportName === undefined) return undefined;

  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === defaultExportName,
  );
}

function parseJavaScript(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

const COMPONENT_BOUNDARY_TOKEN = /\.\s*component\s*\(/;

/** Finds component boundary calls with exactly one argument. */
export function findOneArgumentServerComponentBoundaries(
  source: string,
  fileName = 'component.js',
): ServerComponentBoundary[] {
  if (!COMPONENT_BOUNDARY_TOKEN.test(source)) return [];

  const sourceFile = parseJavaScript(source, fileName);
  const boundaries: ServerComponentBoundary[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isServerComponentBoundaryCall(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      boundaries.push({
        column: position.character + 1,
        index: node.getStart(sourceFile),
        line: position.line + 1,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return boundaries;
}

/** Preserves the identity of a server component while transforming its source. */
export function preserveServerComponentIdentity(source: string, fileName = 'component.js'): string {
  const sourceFile = parseJavaScript(source, fileName);
  const componentFunction = findDefaultComponentFunction(sourceFile);
  const componentName = componentFunction?.name?.text;
  if (componentFunction?.body === undefined || componentName === undefined) return source;

  const insertionIndexes: number[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isServerComponentBoundaryCall(node)) {
      const firstArgument = node.arguments[0];
      if (firstArgument !== undefined) insertionIndexes.push(firstArgument.getEnd());
    }

    ts.forEachChild(node, visit);
  }

  visit(componentFunction.body);

  if (insertionIndexes.length === 0) return source;

  let transformedSource = source;
  const sortedInsertionIndexes = Array.from(insertionIndexes);
  sortedInsertionIndexes.sort((left, right) => right - left);
  for (const insertionIndex of sortedInsertionIndexes) {
    transformedSource =
      transformedSource.slice(0, insertionIndex) +
      `, ${componentName}` +
      transformedSource.slice(insertionIndex);
  }
  return transformedSource;
}

/** Compiles a Svelte component for Bun's module loader. */
export function compileSvelteComponentForBun(
  source: string,
  path: string,
  options: Required<Pick<SvelteCompilerPluginOptions, 'generate' | 'injectCss'>>,
  hooks: SvelteCompilerPluginHooks,
  development?: boolean,
): { contents: string; loader: 'js'; resolveDir: string } {
  // Parsing a component to look for a `<style>` block costs about half of compiling it, so
  // only do it when a policy hook exists to consult.
  if (
    hooks.allowStyleBlock !== undefined &&
    hasAuthoredStyleBlock(source) &&
    !hooks.allowStyleBlock(path)
  ) {
    throw new Error(
      `[svelte-plugin] <style> block in ${path} is not allowed by this test compiler configuration.`,
    );
  }

  const filename = hooks.filename?.(path) ?? path;
  const dev = development ?? environmentConfiguration().nodeEnv !== 'production';
  const result = compile(source, {
    filename,
    generate: options.generate,
    css: options.injectCss ? 'injected' : 'external',
    dev,
  });

  const code =
    options.generate === 'server'
      ? (hooks.transformServerOutput?.({ code: result.js.code, path, dev }) ?? result.js.code)
      : result.js.code;

  return { contents: code, loader: 'js', resolveDir: dirname(path) };
}

/** Compiles a Svelte rune module for Bun's module loader. */
export function compileSvelteRuneModuleForBun(
  source: string,
  path: string,
  generate: SvelteGenerationTarget,
  development?: boolean,
): { contents: string; loader: 'js'; resolveDir: string } {
  const moduleSource = path.endsWith('.ts') ? typeScriptTranspiler.transformSync(source) : source;
  const result = compileModule(moduleSource, {
    filename: path,
    generate,
    dev: development ?? environmentConfiguration().nodeEnv !== 'production',
  });

  return { contents: result.js.code, loader: 'js', resolveDir: dirname(path) };
}

/** Creates the Bun plugin used to compile Svelte source in tests. */
export function sveltePlugin(options: SvelteCompilerPluginOptions = {}): BunPlugin {
  const generate = options.generate ?? 'client';
  const injectCss = options.injectCss ?? false;

  return {
    name: `svelte-${generate}`,
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) =>
        compileSvelteComponentForBun(
          await Bun.file(path).text(),
          path,
          { generate, injectCss },
          {
            allowStyleBlock: options.allowStyleBlock,
            filename: options.filename,
            transformServerOutput: options.transformServerOutput,
          },
          options.development,
        ),
      );

      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) =>
        compileSvelteRuneModuleForBun(
          await Bun.file(path).text(),
          path,
          generate,
          options.development,
        ),
      );
    },
  };
}
