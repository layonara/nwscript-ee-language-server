import { CompletionItemKind } from "vscode-languageserver";
import type { ComplexToken, FunctionComplexToken, FunctionParamComplexToken, StructComplexToken, VariableComplexToken, ConstantComplexToken, StructPropertyComplexToken } from "../Tokenizer/types";
import type { ASTNode, AST } from "./ASTTypes";
import { ASTOperation, getTypeFromNode, isOperation } from "./ASTTypes";

/**
 * Extract ComplexTokens from an AST for global scope
 */
export function extractGlobalTokens(ast: AST): {
  complexTokens: ComplexToken[];
  structComplexTokens: StructComplexToken[];
  children: string[];
} {
  const complexTokens: ComplexToken[] = [];
  const structComplexTokens: StructComplexToken[] = [];
  const children: string[] = [];
  let inGlobalScope = false;

  function traverse(node: ASTNode | null): void {
    if (!node) return;

    // Track when we're in global scope
    const wasInGlobalScope = inGlobalScope;
    if (isOperation(node, ASTOperation.GLOBAL_VARIABLES)) {
      inGlobalScope = true;
    }

    // Extract function declarations
    if (isOperation(node, ASTOperation.FUNCTION)) {
      const func = extractFunction(node);
      if (func) {
        complexTokens.push(func);
      }
    }

    // Extract struct definitions
    if (isOperation(node, ASTOperation.STRUCTURE_DEFINITION)) {
      const struct = extractStruct(node);
      if (struct) {
        structComplexTokens.push(struct);
      }
    }

    // Extract constants and global variables
    if (isOperation(node, ASTOperation.KEYWORD_DECLARATION)) {
      // In global scope, all declarations are treated as constants
      if (inGlobalScope) {
        const constant = extractGlobalVariable(node);
        if (constant) {
          complexTokens.push(constant);
        }
      } else {
        // In local scope, only extract if it's explicitly const
        const constant = extractConstant(node);
        if (constant) {
          complexTokens.push(constant);
        }
      }
    }

    // Note: Include directives are not in the AST, they're resolved during compilation
    // We would need to track them separately if needed

    // Traverse children
    traverse(node.left);
    traverse(node.right);

    inGlobalScope = wasInGlobalScope;
  }

  traverse(ast.ast);

  return {
    complexTokens,
    structComplexTokens,
    children,
  };
}

/**
 * Extract function information from FUNCTION node
 */
function extractFunction(node: ASTNode): FunctionComplexToken | null {
  // Get function declaration
  const funcDecl = node.left;
  if (!funcDecl || !isOperation(funcDecl, ASTOperation.FUNCTION_DECLARATION)) {
    return null;
  }

  // Get function identifier node
  const funcIdent = funcDecl.left;
  if (!funcIdent || !isOperation(funcIdent, ASTOperation.FUNCTION_IDENTIFIER)) {
    return null;
  }

  // Get function name from FUNCTION_IDENTIFIER node
  const identifier = funcIdent.stringData;
  if (!identifier) return null;

  // Position (convert from 1-indexed to 0-indexed)
  const position = {
    line: funcIdent.position.line - 1,
    character: funcIdent.position.char,
  };

  // Extract return type from function identifier's left child
  let returnType = "void";
  if (funcIdent.left) {
    const typeStr = getTypeFromNode(funcIdent.left);
    if (typeStr) returnType = typeStr;
  }

  // Extract parameters
  const params = extractFunctionParams(funcDecl);

  // Extract comments (not available in AST, would need separate tracking)
  const comments: string[] = [];

  return {
    position,
    identifier,
    tokenType: CompletionItemKind.Function,
    returnType: returnType as any,
    params,
    comments,
  };
}

/**
 * Extract function parameters
 */
function extractFunctionParams(funcDeclNode: ASTNode | null): FunctionParamComplexToken[] {
  const params: FunctionParamComplexToken[] = [];

  function findParams(node: ASTNode | null): void {
    if (!node) return;

    if (isOperation(node, ASTOperation.FUNCTION_PARAM_NAME) && node.stringData) {
      // Find the parameter type by looking at the right child
      let paramType = "int"; // Default

      // The type is in the right child of FUNCTION_PARAM_NAME
      if (node.right) {
        const typeStr = getTypeFromNode(node.right);
        if (typeStr) paramType = typeStr;
      }

      const param: FunctionParamComplexToken = {
        position: {
          line: node.position.line - 1,
          character: node.position.char,
        },
        identifier: node.stringData,
        tokenType: CompletionItemKind.TypeParameter,
        valueType: paramType as any,
      };

      params.push(param);
    }

    // Don't traverse into the right child if it's a type keyword
    // to avoid processing it as a parameter
    if (node.right && !node.right.operation.startsWith("KEYWORD_")) {
      findParams(node.right);
    }

    findParams(node.left);
  }

  findParams(funcDeclNode);
  return params;
}

/**
 * Extract struct definition
 */
function extractStruct(node: ASTNode): StructComplexToken | null {
  // Find the KEYWORD_STRUCT node which has the struct name
  const structNode = findFirstNode(node, ASTOperation.KEYWORD_STRUCT);
  if (!structNode || !structNode.stringData) return null;

  const identifier = structNode.stringData;
  const position = {
    line: structNode.position.line - 1,
    character: structNode.position.char,
  };

  // Extract properties from the struct body
  const properties = extractStructProperties(node);

  return {
    position,
    identifier,
    tokenType: CompletionItemKind.Struct,
    properties,
  };
}

/**
 * Extract struct properties
 */
function extractStructProperties(structDefNode: ASTNode): StructPropertyComplexToken[] {
  const properties: StructPropertyComplexToken[] = [];

  function traverse(node: ASTNode | null, depth: number = 0): void {
    if (!node || depth > 50) return; // Prevent infinite recursion

    // Look for KEYWORD_DECLARATION nodes within the struct
    if (isOperation(node, ASTOperation.KEYWORD_DECLARATION)) {
      const prop = extractStructProperty(node);
      if (prop) {
        properties.push(prop);
      }
    }

    traverse(node.left, depth + 1);
    traverse(node.right, depth + 1);
  }

  traverse(structDefNode.right); // Properties are typically in the right subtree
  return properties;
}

/**
 * Extract a single struct property
 */
function extractStructProperty(declNode: ASTNode): StructPropertyComplexToken | null {
  // Get the type from the left child
  let valueType = "int";
  if (declNode.left) {
    const typeStr = getTypeFromNode(declNode.left);
    if (typeStr) valueType = typeStr;
  }

  // Get the variable name from the right child
  const varList = declNode.right;
  if (!varList) return null;

  const varNode = findFirstNode(varList, ASTOperation.VARIABLE);
  if (!varNode || !varNode.stringData) return null;

  return {
    position: {
      line: varNode.position.line - 1,
      character: varNode.position.char,
    },
    identifier: varNode.stringData,
    tokenType: CompletionItemKind.Property,
    valueType: valueType as any,
  };
}

/**
 * Extract global variable declaration (treated as constant in NWScript)
 */
function extractGlobalVariable(declNode: ASTNode): ConstantComplexToken | null {
  // For global variables, the KEYWORD_DECLARATION node has stringData with the variable name
  const identifier = declNode.stringData;
  if (!identifier) {
    // Fallback: look for VARIABLE node
    const varNode = findFirstNode(declNode.right, ASTOperation.VARIABLE);
    if (!varNode || !varNode.stringData) return null;

    return extractGlobalVariableFromVarNode(declNode, varNode);
  }

  // Get the type from the left child
  let valueType = "int";
  if (declNode.left) {
    const typeStr = getTypeFromNode(declNode.left);
    if (typeStr) valueType = typeStr;
  }

  // Get the value from assignment
  let value: string | number = "";
  const assignNode = findFirstNode(declNode.right, ASTOperation.ASSIGNMENT);
  if (assignNode) {
    value = extractConstantValue(assignNode);
  }

  return {
    position: {
      line: declNode.position.line - 1,
      character: declNode.position.char,
    },
    identifier,
    tokenType: CompletionItemKind.Constant,
    valueType: valueType as any,
    value,
  };
}

/**
 * Extract global variable from a VARIABLE node
 */
function extractGlobalVariableFromVarNode(declNode: ASTNode, varNode: ASTNode): ConstantComplexToken | null {
  // Get the type
  let valueType = "int";
  if (declNode.left) {
    const typeStr = getTypeFromNode(declNode.left);
    if (typeStr) valueType = typeStr;
  }

  // Get the value from assignment
  let value: string | number = "";
  const assignNode = findFirstNode(declNode.right, ASTOperation.ASSIGNMENT);
  if (assignNode) {
    value = extractConstantValue(assignNode);
  }

  return {
    position: {
      line: varNode.position.line - 1,
      character: varNode.position.char,
    },
    identifier: varNode.stringData!,
    tokenType: CompletionItemKind.Constant,
    valueType: valueType as any,
    value,
  };
}

/**
 * Extract constant declaration (with explicit const keyword)
 */
function extractConstant(declNode: ASTNode): ConstantComplexToken | null {
  // Check if this is a const declaration
  if (!declNode.left || !isOperation(declNode.left, ASTOperation.KEYWORD_CONST)) {
    return null;
  }

  // Find the variable name
  const varNode = findFirstNode(declNode.right, ASTOperation.VARIABLE);
  if (!varNode || !varNode.stringData) return null;

  // Get the type
  let valueType = "int";
  const typeNode = findFirstNode(declNode.left?.right, "KEYWORD_");
  if (typeNode) {
    const typeStr = getTypeFromNode(typeNode);
    if (typeStr) valueType = typeStr;
  }

  // Get the value from assignment
  let value: string | number = "";
  const assignNode = findFirstNode(declNode.right, ASTOperation.ASSIGNMENT);
  if (assignNode) {
    value = extractConstantValue(assignNode);
  }

  return {
    position: {
      line: varNode.position.line - 1,
      character: varNode.position.char,
    },
    identifier: varNode.stringData,
    tokenType: CompletionItemKind.Constant,
    valueType: valueType as any,
    value,
  };
}

/**
 * Extract constant value from assignment node
 */
function extractConstantValue(assignNode: ASTNode): string | number {
  const constantNode = findFirstNode(assignNode, "CONSTANT_");

  if (!constantNode) return "";

  if (isOperation(constantNode, ASTOperation.CONSTANT_INTEGER)) {
    return constantNode.integerData?.[0] ?? 0;
  }

  if (isOperation(constantNode, ASTOperation.CONSTANT_FLOAT)) {
    return constantNode.floatData ?? 0.0;
  }

  if (isOperation(constantNode, ASTOperation.CONSTANT_STRING)) {
    return constantNode.stringData ?? "";
  }

  return "";
}

/**
 * Find first node matching operation (supports prefix matching with _)
 */
function findFirstNode(node: ASTNode | null, operation: string): ASTNode | null {
  if (!node) return null;

  const isPrefix = operation.endsWith("_");
  const matches = isPrefix ? node.operation.startsWith(operation) : node.operation === operation;

  if (matches) return node;

  return findFirstNode(node.left, operation) || findFirstNode(node.right, operation);
}

/**
 * Extract local scope tokens (functions and variables within a scope)
 */
export function extractLocalTokens(
  ast: AST,
  startLine: number,
  endLine: number,
): {
  functionsComplexTokens: FunctionComplexToken[];
  functionVariablesComplexTokens: (VariableComplexToken | FunctionParamComplexToken)[];
} {
  const functionsComplexTokens: FunctionComplexToken[] = [];
  const functionVariablesComplexTokens: (VariableComplexToken | FunctionParamComplexToken)[] = [];

  function traverse(node: ASTNode | null): void {
    if (!node) return;

    const nodeLine = node.position.line - 1;

    // Only process nodes within the specified line range
    if (nodeLine < startLine || nodeLine > endLine) {
      // But still traverse children in case they're in range
      traverse(node.left);
      traverse(node.right);
      return;
    }

    // Extract function declarations (local functions)
    if (isOperation(node, ASTOperation.FUNCTION)) {
      const func = extractFunction(node);
      if (func && func.position.line >= startLine && func.position.line <= endLine) {
        functionsComplexTokens.push(func);
      }
    }

    // Extract local variables
    if (isOperation(node, ASTOperation.KEYWORD_DECLARATION)) {
      const variables = extractLocalVariables(node);
      variables.forEach((v) => {
        if (v.position.line >= startLine && v.position.line <= endLine) {
          functionVariablesComplexTokens.push(v);
        }
      });
    }

    // Extract function parameters
    if (isOperation(node, ASTOperation.FUNCTION_PARAM_NAME) && node.stringData) {
      const param = extractFunctionParam(node);
      if (param && param.position.line >= startLine && param.position.line <= endLine) {
        functionVariablesComplexTokens.push(param);
      }
    }

    traverse(node.left);
    traverse(node.right);
  }

  traverse(ast.ast);

  return {
    functionsComplexTokens,
    functionVariablesComplexTokens,
  };
}

/**
 * Extract local variables from a declaration node
 */
function extractLocalVariables(declNode: ASTNode): VariableComplexToken[] {
  const variables: VariableComplexToken[] = [];

  // Get the type
  let valueType = "int";
  if (declNode.left) {
    const typeStr = getTypeFromNode(declNode.left);
    if (typeStr) valueType = typeStr;
  }

  // Find all variable nodes in the right subtree
  function findVariables(node: ASTNode | null): void {
    if (!node) return;

    if (isOperation(node, ASTOperation.VARIABLE) && node.stringData) {
      variables.push({
        position: {
          line: node.position.line - 1,
          character: node.position.char,
        },
        identifier: node.stringData,
        tokenType: CompletionItemKind.Variable,
        valueType: valueType as any,
      });
    }

    findVariables(node.left);
    findVariables(node.right);
  }

  findVariables(declNode.right);
  return variables;
}

/**
 * Extract a function parameter
 */
function extractFunctionParam(paramNode: ASTNode): FunctionParamComplexToken | null {
  if (!paramNode.stringData) return null;

  let valueType = "int";
  if (paramNode.right) {
    const typeStr = getTypeFromNode(paramNode.right);
    if (typeStr) valueType = typeStr;
  }

  return {
    position: {
      line: paramNode.position.line - 1,
      character: paramNode.position.char,
    },
    identifier: paramNode.stringData,
    tokenType: CompletionItemKind.TypeParameter,
    valueType: valueType as any,
  };
}
