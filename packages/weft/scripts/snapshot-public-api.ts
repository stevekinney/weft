/**
 * Developer helper: snapshot the public API surface emitted by package export
 * declaration files into tmp/public-api.snapshot.txt.
 *
 * The script walks exported declaration files with the TypeScript compiler API
 * and canonicalizes each exported symbol to one line. Use it locally when you
 * want a textual diff of the public surface across two builds; the snapshot is
 * not checked in and is not part of the CI gate (audit-jsdoc-manifest covers
 * structural drift via the emitted .d.ts files).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
const SNAPSHOT_PATH = resolve(REPO_ROOT, 'tmp/public-api.snapshot.txt');
const TSCONFIG_PATH = resolve(REPO_ROOT, 'tsconfig.json');
const HEADER = '# Public API surface snapshot — see scripts/snapshot-public-api.ts';
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

type ProgramBuild = { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile };
type PackageEntrypoint = { subpath: string; dtsPath: string };

let cachedCompilerOptions: ts.CompilerOptions | null = null;

function readPackageExports(): PackageEntrypoint[] {
  const parsedPackageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  if (!isRecord(parsedPackageJson) || !isRecord(parsedPackageJson.exports)) {
    throw new Error('package.json must define an exports map.');
  }

  return Object.entries(parsedPackageJson.exports)
    .flatMap(([subpath, exportValue]) => packageEntrypointsFor(subpath, exportValue))
    .toSorted((left, right) =>
      left.subpath < right.subpath ? -1 : left.subpath > right.subpath ? 1 : 0,
    );
}

function packageEntrypointsFor(subpath: string, exportValue: unknown): PackageEntrypoint[] {
  if (!isRecord(exportValue)) return [];

  const typesPath = exportValue.types;
  if (typeof typesPath === 'string') {
    return [{ subpath, dtsPath: resolve(REPO_ROOT, typesPath) }];
  }

  return Object.entries(exportValue)
    .flatMap(([conditionLabel, conditionValue]) => {
      if (!isRecord(conditionValue)) return [];

      const conditionalTypesPath = conditionValue.types;
      if (typeof conditionalTypesPath !== 'string') return [];

      return [
        {
          subpath: `${subpath} (${conditionLabel})`,
          dtsPath: resolve(REPO_ROOT, conditionalTypesPath),
        },
      ];
    })
    .toSorted((left, right) =>
      left.subpath < right.subpath ? -1 : left.subpath > right.subpath ? 1 : 0,
    );
}

function buildProgram(entryPath: string): ProgramBuild {
  const program = ts.createProgram([entryPath], readCompilerOptions());
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryPath);
  if (!sourceFile) {
    console.error(`Error: unable to load ${entryPath}.`);
    process.exit(1);
  }
  return { program, checker, sourceFile };
}

function readCompilerOptions(): ts.CompilerOptions {
  if (cachedCompilerOptions !== null) return cachedCompilerOptions;

  const configFile = ts.readConfigFile(TSCONFIG_PATH, (path) => ts.sys.readFile(path));
  if (configFile.error) {
    console.error(ts.formatDiagnostic(configFile.error, diagnosticFormatHost()));
    process.exit(1);
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticFormatHost()));
    process.exit(1);
  }

  cachedCompilerOptions = {
    ...parsed.options,
    noEmit: true,
  };
  return cachedCompilerOptions;
}

function diagnosticFormatHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => '\n',
  };
}

function extractExportLines(
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(sourceFile.fileName)) return [];
  visited.add(sourceFile.fileName);

  const lines: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      lines.push(...exportDeclarationLines(statement, program, checker, sourceFile, visited));
      continue;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const line = variableDeclarationLine(declaration, checker);
        if (line) lines.push(line);
      }
      continue;
    }
    if (hasExportModifier(statement)) {
      const line = namedDeclarationLine(statement, checker);
      if (line) lines.push(line);
    }
  }
  return lines;
}

function exportDeclarationLines(
  declaration: ts.ExportDeclaration,
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  visited: Set<string>,
): string[] {
  const moduleSpecifier = stringModuleSpecifier(declaration.moduleSpecifier);
  if (!declaration.exportClause) {
    if (!moduleSpecifier) return [];
    const exportedSourceFile = resolveExportedSourceFile(program, sourceFile, moduleSpecifier);
    if (!exportedSourceFile) return [];
    return extractExportLines(program, checker, exportedSourceFile, visited);
  }

  if (!ts.isNamedExports(declaration.exportClause)) return [];

  if (!moduleSpecifier) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return [];
    const moduleExports = checker.getExportsOfModule(moduleSymbol);
    return declaration.exportClause.elements
      .map((element) => lineForExportSpecifier(element, checker, moduleExports))
      .filter(isString);
  }

  const exportedSourceFile = resolveExportedSourceFile(program, sourceFile, moduleSpecifier);
  if (!exportedSourceFile) return [];
  const moduleSymbol = checker.getSymbolAtLocation(exportedSourceFile);
  if (!moduleSymbol) return [];
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  return declaration.exportClause.elements
    .map((element) => lineForExportSpecifier(element, checker, moduleExports))
    .filter(isString);
}

function lineForExportSpecifier(
  element: ts.ExportSpecifier,
  checker: ts.TypeChecker,
  moduleExports: ts.Symbol[],
): string | null {
  const exportedName = element.name.text;
  const localName = element.propertyName?.text ?? exportedName;
  let symbol = moduleExports.find((candidate) => candidate.getName() === localName);
  // Bun barrel workaround: `const exportedX = X; export { exportedX as X };`
  // Here `localName === 'exportedX'` is not in `moduleExports` (only the
  // re-aliased export is). Resolve via the property-name node directly.
  if (!symbol && element.propertyName) {
    symbol = checker.getSymbolAtLocation(element.propertyName) ?? undefined;
  }
  if (!symbol) return null;
  return symbolLine(symbol, checker, exportedName);
}

function resolveExportedSourceFile(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
): ts.SourceFile | null {
  const resolvedModule = ts.resolveModuleName(
    moduleSpecifier,
    sourceFile.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;

  if (resolvedModule) {
    const resolvedSourceFile = program.getSourceFile(resolvedModule.resolvedFileName);
    if (resolvedSourceFile) return resolvedSourceFile;
  }

  const basePath = resolve(dirname(sourceFile.fileName), moduleSpecifier);
  const declarationPath = declarationPathFor(basePath);
  return program.getSourceFile(declarationPath) ?? null;
}

function declarationPathFor(basePath: string): string {
  if (basePath.endsWith('.d.ts')) return basePath;
  if (basePath.endsWith('.js')) return `${basePath.slice(0, -'.js'.length)}.d.ts`;
  return `${basePath}.d.ts`;
}

function stringModuleSpecifier(moduleSpecifier: ts.Expression | undefined): string | null {
  if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return null;
  return moduleSpecifier.text;
}

function namedDeclarationLine(declaration: ts.Statement, checker: ts.TypeChecker): string | null {
  if (
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration)
  ) {
    if (!declaration.name) return null;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return null;
    return symbolLine(symbol, checker, declaration.name.text);
  }
  return null;
}

function symbolLine(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  exportedName: string = symbol.getName(),
): string | null {
  const resolvedSymbol = resolveAlias(symbol, checker);
  const declarations = resolvedSymbol.declarations ?? [];
  const classDeclaration = declarations.find(ts.isClassDeclaration);
  if (classDeclaration) return classLine(classDeclaration, checker, exportedName);

  const interfaceDeclaration = declarations.find(ts.isInterfaceDeclaration);
  if (interfaceDeclaration) return interfaceLine(interfaceDeclaration, checker, exportedName);

  const typeAliasDeclaration = declarations.find(ts.isTypeAliasDeclaration);
  if (typeAliasDeclaration) return typeAliasLine(typeAliasDeclaration, checker, exportedName);

  const functionDeclaration = declarations.find(ts.isFunctionDeclaration);
  if (functionDeclaration) return functionLine(functionDeclaration, checker, exportedName);

  const variableDeclaration = declarations.find(ts.isVariableDeclaration);
  if (variableDeclaration)
    return variableDeclarationLine(variableDeclaration, checker, exportedName);

  return null;
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current.flags & ts.SymbolFlags.Alias) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function typeAliasLine(
  declaration: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const type = checker.getTypeFromTypeNode(declaration.type);
  return `type ${exportedName} = ${typeAliasString(checker, type, declaration.type)}`;
}

function interfaceLine(
  declaration: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const members = sortedMemberSignatures(declaration.members, checker);
  // When the interface only extends others (no own members), walk the
  // heritage clauses so the snapshot reflects the actual public shape.
  if (
    members.length === 0 &&
    declaration.heritageClauses &&
    declaration.heritageClauses.length > 0
  ) {
    const inherited = inheritedMemberSignatures(declaration, checker);
    if (inherited.length > 0) {
      return `interface ${exportedName} { ${inherited.join('; ')} }`;
    }
  }
  return `interface ${exportedName} { ${members.join('; ')} }`;
}

function inheritedMemberSignatures(
  declaration: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
): string[] {
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return [];
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const properties = checker.getPropertiesOfType(type);
  const lines: string[] = [];
  for (const property of properties) {
    const propertyDeclaration = property.declarations?.[0];
    if (
      propertyDeclaration &&
      (ts.isPropertySignature(propertyDeclaration) ||
        ts.isMethodSignature(propertyDeclaration) ||
        ts.isPropertyDeclaration(propertyDeclaration) ||
        ts.isMethodDeclaration(propertyDeclaration))
    ) {
      const line = memberSignature(propertyDeclaration, checker);
      if (line !== null) lines.push(line);
    }
  }
  return lines.toSorted((left, right) => {
    const leftName = memberSortName(left);
    const rightName = memberSortName(right);
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function classLine(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const members = sortedMemberSignatures(declaration.members, checker);
  return `class ${exportedName} { ${members.join('; ')} }`;
}

function functionLine(
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const typeParameters = typeParameterSignature(declaration.typeParameters);
  return `function ${exportedName}${typeParameters}(${parameterSignatures(
    declaration.parameters,
    checker,
  ).join(', ')}): ${returnTypeSignature(declaration, checker)}`;
}

function variableDeclarationLine(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  exportedName?: string,
  visited: Set<ts.VariableDeclaration> = new Set(),
): string | null {
  if (!ts.isIdentifier(declaration.name)) return null;
  const name = exportedName ?? declaration.name.text;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return null;
  // Bun barrel workaround: `const exportedX = X; export { exportedX as X }`
  // makes `X` look like a value with type `typeof RealX`. Reflect the
  // underlying class/function instead of a useless `const X: typeof X`.
  const aliasLine = aliasedRebindLine(declaration, checker, name, visited);
  if (aliasLine !== null) return aliasLine;
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return `const ${name}: ${typeString(checker, type, declaration)}`;
}

function aliasedRebindLine(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
  visited: Set<ts.VariableDeclaration>,
): string | null {
  // Two source patterns produce a value-aliasing rebind, both common in
  // barrel files that work around the Bun 1.3.13 minifier bug:
  //   1. Source `.ts`: `const exportedX = X;` — initializer is an identifier.
  //   2. Emitted `.d.ts`: `declare const exportedX: typeof X;` — type annotation
  //      is a TypeQueryNode whose name is the identifier we want to follow.
  // Track visited variable declarations across the recursion so an indirect
  // cycle (A → B → A) terminates instead of overflowing the stack.
  if (visited.has(declaration)) return null;
  visited.add(declaration);
  const target = aliasTargetSymbol(declaration, checker);
  if (target === null) return null;
  const resolved = resolveAlias(target, checker);
  const declarations = resolved.declarations ?? [];
  const classDeclaration = declarations.find(ts.isClassDeclaration);
  if (classDeclaration) return classLine(classDeclaration, checker, exportedName);
  const functionDeclaration = declarations.find(ts.isFunctionDeclaration);
  if (functionDeclaration) return functionLine(functionDeclaration, checker, exportedName);
  const variableDeclaration = declarations.find(ts.isVariableDeclaration);
  if (variableDeclaration && !visited.has(variableDeclaration)) {
    return variableDeclarationLine(variableDeclaration, checker, exportedName, visited);
  }
  return null;
}

function aliasTargetSymbol(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
): ts.Symbol | null {
  const initializer = declaration.initializer;
  if (initializer !== undefined && ts.isIdentifier(initializer)) {
    return checker.getSymbolAtLocation(initializer) ?? null;
  }
  const typeNode = declaration.type;
  if (typeNode !== undefined && ts.isTypeQueryNode(typeNode)) {
    const exprName = typeNode.exprName;
    const target = ts.isIdentifier(exprName) ? exprName : exprName.right;
    return checker.getSymbolAtLocation(target) ?? null;
  }
  return null;
}

function sortedMemberSignatures(
  members: ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>,
  checker: ts.TypeChecker,
): string[] {
  return members
    .map((member) => memberSignature(member, checker))
    .filter(isString)
    .toSorted((left, right) => {
      const leftName = memberSortName(left);
      const rightName = memberSortName(right);
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function memberSignature(
  member: ts.TypeElement | ts.ClassElement,
  checker: ts.TypeChecker,
): string | null {
  if (isNonPublicMember(member)) return null;

  if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const type = memberType(member, checker);
    if (!type) return null;
    return `${memberPrefixes(member)}${name}${optionalMarker(member)}: ${type}`;
  }

  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const typeParameters = typeParameterSignature(member.typeParameters);
    return `${memberPrefixes(member)}${name}${optionalMarker(member)}${typeParameters}(${parameterSignatures(
      member.parameters,
      checker,
    ).join(', ')}): ${returnTypeSignature(member, checker)}`;
  }

  if (ts.isGetAccessorDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    return `${memberPrefixes(member)}${name}: ${returnTypeSignature(member, checker)}`;
  }

  if (ts.isSetAccessorDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const parameter = member.parameters[0];
    if (!parameter) return null;
    return `${memberPrefixes(member)}${name}: ${parameterTypeSignature(parameter, checker)}`;
  }

  return null;
}

function memberPrefixes(member: ts.TypeElement | ts.ClassElement): string {
  const prefixes: string[] = [];
  if (hasModifierKind(member, ts.SyntaxKind.StaticKeyword)) prefixes.push('static');
  if (hasModifierKind(member, ts.SyntaxKind.AbstractKeyword)) prefixes.push('abstract');
  if (hasModifierKind(member, ts.SyntaxKind.ReadonlyKeyword)) prefixes.push('readonly');
  return prefixes.length > 0 ? `${prefixes.join(' ')} ` : '';
}

function memberSortName(signature: string): string {
  let rest = signature;
  for (const prefix of ['static ', 'abstract ', 'readonly ']) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
    }
  }
  const delimiterIndexes = ['?', ':', '(']
    .map((delimiter) => rest.indexOf(delimiter))
    .filter((index) => index >= 0);
  if (delimiterIndexes.length === 0) return rest;
  return rest.slice(0, Math.min(...delimiterIndexes));
}

function isNonPublicMember(member: ts.TypeElement | ts.ClassElement): boolean {
  if (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isGetAccessorDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isSetAccessorDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  return (
    hasModifierKind(member, ts.SyntaxKind.PrivateKeyword) ||
    hasModifierKind(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifierKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function memberName(name: ts.PropertyName | undefined): string | null {
  if (!name || ts.isPrivateIdentifier(name)) return null;
  return normalizeSignatureText(name.getText());
}

function optionalMarker(
  member: ts.MethodSignature | ts.MethodDeclaration | ts.PropertySignature | ts.PropertyDeclaration,
): string {
  return member.questionToken ? '?' : '';
}

function memberType(
  member: ts.PropertySignature | ts.PropertyDeclaration,
  checker: ts.TypeChecker,
): string | null {
  if (member.type) return typeString(checker, checker.getTypeFromTypeNode(member.type), member);
  const symbol = checker.getSymbolAtLocation(member.name);
  if (symbol) {
    return typeString(checker, checker.getTypeOfSymbolAtLocation(symbol, member), member);
  }
  return null;
}

function parameterSignatures(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  checker: ts.TypeChecker,
): string[] {
  return parameters.map((parameter) => parameterSignature(parameter, checker));
}

function parameterSignature(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): string {
  const restPrefix = parameter.dotDotDotToken ? '...' : '';
  const optional = parameter.questionToken ? '?' : '';
  const name = normalizeSignatureText(parameter.name.getText());
  return `${restPrefix}${name}${optional}: ${parameterTypeSignature(parameter, checker)}`;
}

function parameterTypeSignature(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): string {
  if (parameter.type)
    return typeString(checker, checker.getTypeFromTypeNode(parameter.type), parameter);
  const symbol = checker.getSymbolAtLocation(parameter.name);
  if (!symbol) return 'unknown';
  return typeString(checker, checker.getTypeOfSymbolAtLocation(symbol, parameter), parameter);
}

function returnTypeSignature(
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): string {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (signature) return typeString(checker, signature.getReturnType(), declaration);
  if (declaration.type)
    return typeString(checker, checker.getTypeFromTypeNode(declaration.type), declaration);
  return 'void';
}

function typeParameterSignature(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
): string {
  if (!typeParameters || typeParameters.length === 0) return '';
  return `<${typeParameters.map((typeParameter) => normalizeSignatureText(typeParameter.getText())).join(', ')}>`;
}

function typeString(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return normalizeSignatureText(checker.typeToString(type, location, TYPE_FORMAT_FLAGS));
}

function typeAliasString(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return normalizeSignatureText(
    checker.typeToString(type, location, TYPE_FORMAT_FLAGS | ts.TypeFormatFlags.InTypeAlias),
  );
}

function normalizeSignatureText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildEntrypointSection(subpath: string, lines: string[]): string {
  const sortedLines = Array.from(new Set(lines)).toSorted((left, right) => {
    const nameLeft = symbolName(left);
    const nameRight = symbolName(right);
    if (nameLeft !== nameRight) return nameLeft < nameRight ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return [`# Entrypoint: ${subpath}`, ...sortedLines].join('\n');
}

function buildMultiEntrypointSnapshot(sections: readonly string[]): string {
  return `${HEADER}\n\n${sections.join('\n\n')}\n`;
}

function symbolName(line: string): string {
  const firstSpace = line.indexOf(' ');
  if (firstSpace < 0) return line;
  const rest = line.slice(firstSpace + 1).trimStart();
  const delimiterIndexes = [' ', '<', '(', '{', ':', '=']
    .map((delimiter) => rest.indexOf(delimiter))
    .filter((index) => index >= 0);
  if (delimiterIndexes.length === 0) return rest;
  return rest.slice(0, Math.min(...delimiterIndexes));
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function main(): void {
  const entrypoints = readPackageExports();
  const missingEntrypoint = entrypoints.find((entrypoint) => !existsSync(entrypoint.dtsPath));
  if (missingEntrypoint) {
    console.error(
      `Error: ${missingEntrypoint.dtsPath} not found for ${missingEntrypoint.subpath}. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }

  const extractedLinesByPath = new Map<string, string[]>();
  const sections = entrypoints.map(({ subpath, dtsPath }) => {
    const cachedLines = extractedLinesByPath.get(dtsPath);
    if (cachedLines) return buildEntrypointSection(subpath, cachedLines);

    const { program, checker, sourceFile } = buildProgram(dtsPath);
    const lines = extractExportLines(program, checker, sourceFile);
    extractedLinesByPath.set(dtsPath, lines);
    return buildEntrypointSection(subpath, lines);
  });
  const snapshot = buildMultiEntrypointSnapshot(sections);

  const directory = dirname(SNAPSHOT_PATH);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, snapshot);
  console.log(`Wrote ${SNAPSHOT_PATH}`);
}

main();
