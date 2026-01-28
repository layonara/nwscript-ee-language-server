/**
 * TypeScript definitions for NWScript AST
 * Generated from the WASM compiler"s JSON export
 */

export type ASTPosition = {
  file: number;
  line: number;
  char: number;
};

export type ASTNode = {
  operation: string;
  operationId: number;
  position: ASTPosition;

  // Optional data fields
  stringData?: string;
  integerData?: number[];
  floatData?: number;
  vectorData?: number[];

  // Type information
  type?: string;
  typeId?: number;
  typeName?: string;

  // Stack information
  stackPointer?: number;

  // Child nodes
  left: ASTNode | null;
  right: ASTNode | null;
};

export type AST = {
  version: number;
  ast: ASTNode;
};

/**
 * Common AST operation types used in tokenization
 */
export enum ASTOperation {
  // Top level
  FUNCTIONAL_UNIT = "FUNCTIONAL_UNIT",
  GLOBAL_VARIABLES = "GLOBAL_VARIABLES",

  // Functions
  FUNCTION = "FUNCTION",
  FUNCTION_DECLARATION = "FUNCTION_DECLARATION",
  FUNCTION_IDENTIFIER = "FUNCTION_IDENTIFIER",
  FUNCTION_PARAM_NAME = "FUNCTION_PARAM_NAME",

  // Structures
  STRUCTURE_DEFINITION = "STRUCTURE_DEFINITION",
  KEYWORD_STRUCT = "KEYWORD_STRUCT",

  // Variables and constants
  VARIABLE = "VARIABLE",
  VARIABLE_LIST = "VARIABLE_LIST",
  KEYWORD_DECLARATION = "KEYWORD_DECLARATION",
  KEYWORD_CONST = "KEYWORD_CONST",

  // Statements
  STATEMENT = "STATEMENT",
  STATEMENT_LIST = "STATEMENT_LIST",
  COMPOUND_STATEMENT = "COMPOUND_STATEMENT",

  // Types
  KEYWORD_INT = "KEYWORD_INT",
  KEYWORD_FLOAT = "KEYWORD_FLOAT",
  KEYWORD_STRING = "KEYWORD_STRING",
  KEYWORD_OBJECT = "KEYWORD_OBJECT",
  KEYWORD_VOID = "KEYWORD_VOID",
  KEYWORD_VECTOR = "KEYWORD_VECTOR",
  KEYWORD_ACTION = "KEYWORD_ACTION",
  KEYWORD_EFFECT = "KEYWORD_EFFECT",
  KEYWORD_EVENT = "KEYWORD_EVENT",
  KEYWORD_LOCATION = "KEYWORD_LOCATION",
  KEYWORD_TALENT = "KEYWORD_TALENT",
  KEYWORD_ITEMPROPERTY = "KEYWORD_ITEMPROPERTY",
  KEYWORD_JSON = "KEYWORD_JSON",
  KEYWORD_SQLQUERY = "KEYWORD_SQLQUERY",
  KEYWORD_CASSOWARY = "KEYWORD_CASSOWARY",

  // Constants
  CONSTANT_INTEGER = "CONSTANT_INTEGER",
  CONSTANT_FLOAT = "CONSTANT_FLOAT",
  CONSTANT_STRING = "CONSTANT_STRING",
  CONSTANT_OBJECT = "CONSTANT_OBJECT",

  // Expressions
  ASSIGNMENT = "ASSIGNMENT",
  NON_VOID_EXPRESSION = "NON_VOID_EXPRESSION",

  // Control flow
  IF_BLOCK = "IF_BLOCK",
  WHILE_BLOCK = "WHILE_BLOCK",
  FOR_BLOCK = "FOR_BLOCK",
  SWITCH_BLOCK = "SWITCH_BLOCK",

  // Others
  INCLUDE_DIRECTIVE = "INCLUDE_DIRECTIVE",
}

/**
 * Helper to check if a node is a specific operation
 */
export function isOperation(node: ASTNode | null, operation: ASTOperation | string): boolean {
  return node?.operation === operation;
}

/**
 * Helper to get the type string from a type node
 */
export function getTypeFromNode(node: ASTNode | null): string | undefined {
  if (!node) return undefined;

  // Check if it"s a keyword type
  if (node.operation.startsWith("KEYWORD_")) {
    return node.operation.replace("KEYWORD_", "").toLowerCase();
  }

  // Check if it"s a struct type (has stringData with the struct name)
  if (node.operation === "KEYWORD_STRUCT" && node.stringData) {
    return node.stringData;
  }

  return node.stringData || node.typeName;
}
