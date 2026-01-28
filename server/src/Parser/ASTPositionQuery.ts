import { CompletionItemKind } from "vscode-languageserver";
import type { ASTNode, AST } from "./ASTTypes";
import { ASTOperation } from "./ASTTypes";

/**
 * Position-based query service for AST.
 * Provides LSP position-based features using the AST tree structure.
 */
export class ASTPositionQuery {
  constructor(private readonly ast: AST) {}

  /**
   * Find the most specific (deepest) node at the given position.
   * Prefers nodes with identifiers (stringData) over structural nodes.
   *
   * @param line - 0-indexed line number
   * @param char - 0-indexed character position
   * @returns The most specific node at this position, or null
   */
  public findNodeAtPosition(line: number, char: number): ASTNode | null {
    // AST uses 1-indexed lines and chars, convert from 0-indexed LSP positions
    const astLine = line + 1;
    const astChar = char + 1;

    const candidates: Array<{ node: ASTNode; depth: number; distance: number }> = [];

    // Collect all nodes at or before this position with their depth
    const traverse = (node: ASTNode | null, depth: number) => {
      if (!node) return;

      const nodeBeforeTarget = node.position.line < astLine || (node.position.line === astLine && node.position.char <= astChar);

      if (nodeBeforeTarget) {
        // Calculate distance from target position
        const lineDist = Math.abs(node.position.line - astLine);
        const charDist = node.position.line === astLine ? Math.abs(node.position.char - astChar) : 1000;
        const distance = lineDist * 1000 + charDist;

        candidates.push({ node, depth, distance });
      }

      // Always traverse both children to explore all branches
      traverse(node.left, depth + 1);
      traverse(node.right, depth + 1);
    };

    traverse(this.ast.ast, 0);

    if (candidates.length === 0) return null;

    // Sort by specificity:
    // 1. Prefer exact position matches (distance = 0)
    // 2. Prefer deeper nodes (more specific)
    // 3. Prefer nodes with stringData (identifiers, literals)
    // 4. Prefer closer position (smaller distance)
    candidates.sort((a, b) => {
      // Exact position match?
      const aExact = a.distance === 0;
      const bExact = b.distance === 0;

      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Prefer deeper nodes (more specific in the tree)
      if (a.depth !== b.depth) {
        return b.depth - a.depth;
      }

      // Prefer nodes with stringData (actual tokens)
      const aHasData = !!a.node.stringData;
      const bHasData = !!b.node.stringData;

      if (aHasData && !bHasData) return -1;
      if (!aHasData && bHasData) return 1;

      // Prefer closer position
      return a.distance - b.distance;
    });

    return candidates[0].node;
  }

  /**
   * Get action target at position with optional offset.
   * Returns information about the token at or near the cursor.
   *
   * @param line - 0-indexed line number
   * @param char - 0-indexed character position
   * @param offset - Offset to apply (not implemented yet, for compatibility)
   * @returns Token information
   */
  public getActionTargetAtPosition(
    line: number,
    char: number,
    offset: number = 0,
  ): {
    tokenType: CompletionItemKind | undefined;
    lookBehindRawContent: string | undefined;
    rawContent: string | undefined;
  } {
    const node = this.findNodeAtPosition(line, char);

    if (!node) {
      return {
        tokenType: undefined,
        lookBehindRawContent: undefined,
        rawContent: undefined,
      };
    }

    // Determine token type from AST operation
    let tokenType: CompletionItemKind | undefined;
    const rawContent = node.stringData;

    switch (node.operation) {
      case ASTOperation.VARIABLE:
        tokenType = CompletionItemKind.Variable;
        break;
      case ASTOperation.FUNCTION_IDENTIFIER:
      case "ACTION_ID":
        tokenType = CompletionItemKind.Function;
        break;
      case ASTOperation.KEYWORD_STRUCT:
        tokenType = CompletionItemKind.Struct;
        break;
      case ASTOperation.CONSTANT_INTEGER:
      case ASTOperation.CONSTANT_FLOAT:
      case ASTOperation.CONSTANT_STRING:
        tokenType = CompletionItemKind.Constant;
        break;
      default:
        tokenType = undefined;
    }

    // For struct property access, need to find the struct variable
    let lookBehindRawContent: string | undefined;
    if (this.isInStructPropertyAccess(node)) {
      lookBehindRawContent = this.findStructVariableName(node);
    }

    return {
      tokenType,
      lookBehindRawContent,
      rawContent,
    };
  }

  /**
   * Check if position is within a specific scope (e.g., function call).
   *
   * @param line - 0-indexed line number
   * @param char - 0-indexed character position
   * @param scopeType - The scope type to check for
   * @returns True if position is within the scope
   */
  public isInScope(line: number, char: number, scopeType: string): boolean {
    const node = this.findNodeAtPosition(line, char);
    if (!node) return false;

    // Check if we're in a function call scope
    if (scopeType === "function.call" || scopeType.includes("functionCall")) {
      return this.isInFunctionCall(node);
    }

    return false;
  }

  /**
   * Find function name when cursor is inside a function call.
   * Used for signature help.
   *
   * @param line - 0-indexed line number
   * @param char - 0-indexed character position
   * @returns Function name or undefined
   */
  public getFunctionNameAtPosition(line: number, char: number): string | undefined {
    const node = this.findNodeAtPosition(line, char);
    if (!node) return undefined;

    // Look for ACTION node containing this position
    const action = this.findAncestorOfType(node, "ACTION");
    if (!action) return undefined;

    // Find ACTION_ID child
    const actionId = this.findChildOfType(action, "ACTION_ID");
    return actionId?.stringData;
  }

  /**
   * Count the number of arguments before the current position in a function call.
   * Used to determine which parameter is active in signature help.
   *
   * @param line - 0-indexed line number
   * @param char - 0-indexed character position
   * @returns Number of commas found (= argument index)
   */
  public getActiveParameterIndex(line: number, char: number): number {
    const node = this.findNodeAtPosition(line, char);
    if (!node) return 0;

    // Find the ACTION (function call) containing this position
    const action = this.findAncestorOfType(node, "ACTION");
    if (!action) return 0;

    // Count ACTION_ARG_LIST nodes that start before the cursor position
    // Each ACTION_ARG_LIST represents a parameter separator (comma)
    let argIndex = 0;
    const astLine = line + 1;
    const astChar = char + 1;

    const countArgs = (n: ASTNode | null): void => {
      if (!n) return;

      if (n.operation === "ACTION_ARG_LIST") {
        // Count if this arg list starts strictly before our position
        if (n.position.line < astLine || (n.position.line === astLine && n.position.char < astChar)) {
          argIndex++;
        }
      }

      countArgs(n.left);
      countArgs(n.right);
    };

    countArgs(action);

    return argIndex;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Check if node is within a function call.
   */
  private isInFunctionCall(node: ASTNode): boolean {
    return !!this.findAncestorOfType(node, "ACTION");
  }

  /**
   * Check if node is in a struct property access context.
   */
  private isInStructPropertyAccess(node: ASTNode): boolean {
    // This would require checking if we're accessing a struct member
    // For now, return false - implement when needed
    return false;
  }

  /**
   * Find struct variable name for property access.
   */
  private findStructVariableName(node: ASTNode): string | undefined {
    // Implement when struct property access is needed
    return undefined;
  }

  /**
   * Find ancestor node of specific type.
   * Since we don't have parent pointers, we search the entire tree.
   */
  private findAncestorOfType(target: ASTNode, operation: string): ASTNode | null {
    const parents: ASTNode[] = [];

    const findParents = (node: ASTNode | null, path: ASTNode[]): boolean => {
      if (!node) return false;

      if (node === target) {
        parents.push(...path);
        return true;
      }

      const newPath = [...path, node];
      if (findParents(node.left, newPath)) return true;
      if (findParents(node.right, newPath)) return true;

      return false;
    };

    findParents(this.ast.ast, []);

    // Find first parent with matching operation
    return parents.reverse().find((p) => p.operation === operation) || null;
  }

  /**
   * Find first child node with specific operation type.
   */
  private findChildOfType(node: ASTNode, operation: string): ASTNode | null {
    if (node.left?.operation === operation) return node.left;
    if (node.right?.operation === operation) return node.right;

    const leftResult = node.left ? this.findChildOfType(node.left, operation) : null;
    if (leftResult) return leftResult;

    return node.right ? this.findChildOfType(node.right, operation) : null;
  }
}
