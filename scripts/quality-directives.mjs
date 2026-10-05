import ts from "typescript-api";

const scopedRules = new Map([
  [
    "unicorn/no-thenable",
    new Set([
      "src/extension/schemas.ts",
      "src/extension/chain-schema.ts",
      "src/extension/everyday-schemas.ts",
      "src/runs/shared/acceptance-reports.ts",
    ]),
  ],
  [
    "typescript/no-invalid-void-type",
    new Set(["src/slash/prompt-template-bridge.ts", "src/slash/slash-bridge.ts"]),
  ],
]);
const sdkLoads = {
  "src/shared/native-session.ts": { sessionModule: "@earendil-works/pi-coding-agent" },
  "src/shared/native-typebox.ts": {
    typebox: "typebox",
    compile: "typebox/compile",
    value: "typebox/value",
  },
  "src/shared/native-tui.ts": { tui: "@earendil-works/pi-tui" },
};

function descendants(node, predicate) {
  if (predicate(node)) {
    return true;
  }
  return ts.forEachChild(node, (child) => descendants(child, predicate)) === true;
}

function typedSdkLoad(node, expectedModule, source) {
  if (node.type === undefined || node.initializer === undefined) {
    return false;
  }
  const namespace = sdkNamespaceType(node.type, expectedModule, source);
  if (!namespace || !ts.isAwaitExpression(node.initializer)) {
    return false;
  }
  const call = node.initializer.expression;
  if (
    !ts.isCallExpression(call) ||
    call.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  return nativeUrl(call.arguments[0], source);
}

function nativeUrl(expression, source) {
  const url = selectedUrl(expression, source);
  if (url === undefined || !ts.isPropertyAccessExpression(url) || url.name.text !== "href") {
    return false;
  }
  if (ts.isCallExpression(url.expression)) {
    return (
      ts.isIdentifier(url.expression.expression) &&
      url.expression.expression.text === "pathToFileURL"
    );
  }
  return (
    ts.isNewExpression(url.expression) &&
    ts.isIdentifier(url.expression.expression) &&
    url.expression.expression.text === "URL"
  );
}

function selectedUrl(expression, source) {
  if (!ts.isIdentifier(expression)) {
    return expression;
  }
  const binding = source.statements
    .filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .flatMap((statement) => statement.declarationList.declarations)
    .find(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === expression.text,
    );
  return binding?.initializer;
}

function sdkNamespaceType(annotation, expectedModule, source) {
  const type = namespaceAnnotation(annotation);
  if (ts.isTypeQueryNode(type) && ts.isIdentifier(type.exprName)) {
    return source.statements
      .filter(ts.isImportDeclaration)
      .some(
        (statement) =>
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === expectedModule &&
          statement.importClause?.isTypeOnly === true &&
          statement.importClause.namedBindings !== undefined &&
          ts.isNamespaceImport(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.name.text === type.exprName.text,
      );
  }
  return (
    ts.isImportTypeNode(type) &&
    type.isTypeOf &&
    ts.isLiteralTypeNode(type.argument) &&
    ts.isStringLiteral(type.argument.literal) &&
    type.argument.literal.text === expectedModule
  );
}

function namespaceAnnotation(type) {
  if (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "Pick" &&
    type.typeArguments?.length === 2
  ) {
    return type.typeArguments[0];
  }
  return type;
}

function approvedSdkLoad(source, line, file) {
  const loads = sdkLoads[file];
  if (loads === undefined) {
    return false;
  }
  return source.statements
    .filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .some((statement) =>
      statement.declarationList.declarations.some(
        (node) =>
          ts.isIdentifier(node.name) &&
          Object.hasOwn(loads, node.name.text) &&
          source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1 === line &&
          typedSdkLoad(node, loads[node.name.text], source),
      ),
    );
}

export function approvedScopedDirective(rule, source, line, file) {
  if (rule === "typescript/no-unsafe-assignment") {
    // ponytail: these five selected-host namespace loads are the approved Jiti erasure ceiling.
    // Remove this exception when runtime module identity survives the loader and native probes pass.
    return approvedSdkLoad(source, line, file);
  }
  if (!scopedRules.get(rule)?.has(file)) {
    return false;
  }
  if (rule === "unicorn/no-thenable") {
    return descendants(
      source,
      (node) =>
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "then" &&
        source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1 === line &&
        schemaValue(node.initializer),
    );
  }
  return descendants(
    source,
    (node) =>
      node.kind === ts.SyntaxKind.VoidKeyword &&
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === line &&
      optionalUnsubscribe(node.parent),
  );
}

function schemaValue(node) {
  if (
    ts.isObjectLiteralExpression(node) ||
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Type"
  );
}

function optionalUnsubscribe(union) {
  if (
    !ts.isUnionTypeNode(union) ||
    union.types.length !== 2 ||
    !union.types.some((node) => node.kind === ts.SyntaxKind.VoidKeyword)
  ) {
    return false;
  }
  return union.types.some((node) => {
    const type = ts.isParenthesizedTypeNode(node) ? node.type : node;
    return (
      ts.isFunctionTypeNode(type) &&
      type.parameters.length === 0 &&
      type.type.kind === ts.SyntaxKind.VoidKeyword
    );
  });
}
