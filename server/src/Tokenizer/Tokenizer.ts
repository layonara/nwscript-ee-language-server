import { join } from "path";
import { readFileSync } from "fs";

import type { IGrammar } from "vscode-textmate";
import type { Position } from "vscode-languageserver-textdocument";
import { Registry, INITIAL, parseRawGrammar, IToken } from "vscode-textmate";
import { CompletionItemKind } from "vscode-languageserver";

import type { ComplexToken, FunctionComplexToken, FunctionParamComplexToken, StructComplexToken, VariableComplexToken } from "./types";
import { LanguageScopes } from "./constants";
import onigLib from "../onigLib";
import { getParser } from "../Parser/NWScriptParser";
import { extractGlobalTokens, extractLocalTokens } from "../Parser/ASTTraversal";
import type { AST } from "../Parser/ASTTypes";
import { ASTPositionQuery } from "../Parser/ASTPositionQuery";

export enum TokenizedScope {
  global = "global",
  local = "local",
}

export type GlobalScopeTokenizationResult = {
  complexTokens: ComplexToken[];
  structComplexTokens: StructComplexToken[];
  children: string[];
};

export type LocalScopeTokenizationResult = {
  functionsComplexTokens: FunctionComplexToken[];
  functionVariablesComplexTokens: (VariableComplexToken | FunctionParamComplexToken)[];
};

/**
 * Hybrid tokenizer using AST for structural analysis and TextMate for position queries.
 *
 * Architecture:
 * - AST (via NWScript compiler): Parses file structure, extracts functions/variables/structs
 * - TextMate: Provides fine-grained token positions for LSP position-based queries
 *
 * Why hybrid?
 * - AST is great for "what's in this file" but doesn't support "what's at this position"
 * - TextMate is great for cursor position queries but slower for full-file analysis
 */
export default class Tokenizer {
  // TextMate registry for position-based queries
  private readonly registry: Registry;
  private grammar: IGrammar | null = null;

  // AST cache for structural tokenization
  private cachedAST: AST | null = null;
  private lastParsedContent: string = "";

  // AST-based position query service
  private positionQuery: ASTPositionQuery | null = null;

  constructor(localPath = false) {
    this.registry = new Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        return await new Promise((resolve, reject) => {
          if (scopeName === "source.nss") {
            const grammar = readFileSync(join(__dirname, "..", "..", localPath ? ".." : "", "syntaxes", "nwscript-ee.tmLanguage"));
            return resolve(parseRawGrammar(grammar.toString()));
          }
          reject(new Error(`Unknown scope name: ${scopeName}`));
        });
      },
    });
  }

  /**
   * Initialize the TextMate grammar.
   * Must be called before using any tokenization methods.
   */
  public async loadGrammar() {
    this.grammar = await this.registry.loadGrammar("source.nss");
    return this;
  }

  // ============================================================================
  // AST-BASED TOKENIZATION (Structural Analysis)
  // ============================================================================
  // These methods use the NWScript compiler to parse and extract tokens.
  // Used for: indexing files, extracting all functions/variables/structs

  /**
   * Tokenize content using AST parser to extract structural tokens.
   *
   * @param content - The NWScript source code
   * @param scope - Whether to extract global or local scope tokens
   * @param startIndex - Starting line for local scope (0-indexed)
   * @param stopIndex - Ending line for local scope (0-indexed, -1 for end of file)
   * @returns Extracted tokens based on scope
   */

  public tokenizeContent(content: string, scope: TokenizedScope.global, startIndex?: number, stopIndex?: number): Promise<GlobalScopeTokenizationResult>;
  public tokenizeContent(content: string, scope: TokenizedScope.local, startIndex?: number, stopIndex?: number): Promise<LocalScopeTokenizationResult>;
  public async tokenizeContent(content: string, scope: TokenizedScope, startIndex: number = 0, stopIndex: number = -1): Promise<GlobalScopeTokenizationResult | LocalScopeTokenizationResult> {
    // Parse content to AST if not cached or content changed
    if (this.lastParsedContent !== content) {
      const parser = await getParser();
      const { ast, errors } = await parser.parse(content);

      if (ast) {
        this.cachedAST = ast;
        this.lastParsedContent = content;
        this.positionQuery = new ASTPositionQuery(ast);
      } else {
        console.warn("AST parsing failed:", errors);
        return this.getEmptyResult(scope);
      }
    }

    if (!this.cachedAST) {
      return this.getEmptyResult(scope);
    }

    // Extract tokens from AST
    if (scope === TokenizedScope.global) {
      return extractGlobalTokens(this.cachedAST);
    } else {
      const lines = content.split(/\r?\n/);
      const actualStopIndex = stopIndex < 0 ? lines.length : stopIndex;
      return extractLocalTokens(this.cachedAST, startIndex, actualStopIndex);
    }
  }

  /**
   * Tokenize content from raw TextMate tokens to AST-based local scope.
   * Bridge method for providers that still use TextMate for position queries.
   */

  public async tokenizeContentFromRaw(lines: string[], rawTokenizedContent: (IToken[] | undefined)[], startIndex: number = 0, stopIndex: number = -1) {
    const content = lines.join("\n");
    return await this.tokenizeContent(content, TokenizedScope.local, startIndex, stopIndex);
  }

  /**
   * Returns empty tokenization result based on scope.
   */
  private getEmptyResult(scope: TokenizedScope): GlobalScopeTokenizationResult | LocalScopeTokenizationResult {
    if (scope === TokenizedScope.global) {
      return { complexTokens: [], structComplexTokens: [], children: [] };
    } else {
      return { functionsComplexTokens: [], functionVariablesComplexTokens: [] };
    }
  }

  // ============================================================================
  // AST-BASED POSITION QUERIES (Preferred)
  // ============================================================================
  // These methods use AST tree structure for position-based queries.
  // More accurate and faster than TextMate for most use cases.

  /**
   * Get the token at a specific position using AST.
   * Preferred over TextMate-based method.
   *
   * @param content - The NWScript source code
   * @param position - Cursor position (0-indexed)
   * @param offset - Offset from position (not implemented yet)
   * @returns Token information including type and content
   */
  public async getActionTargetAtPositionAST(
    content: string,
    position: Position,
    offset: number = 0,
  ): Promise<{
    tokenType: CompletionItemKind | undefined;
    lookBehindRawContent: string | undefined;
    rawContent: string | undefined;
  }> {
    // Ensure we have parsed the content
    await this.tokenizeContent(content, TokenizedScope.global);

    if (!this.positionQuery) {
      return {
        tokenType: undefined,
        lookBehindRawContent: undefined,
        rawContent: undefined,
      };
    }

    return this.positionQuery.getActionTargetAtPosition(position.line, position.character, offset);
  }

  /**
   * Check if position is within a specific scope using AST.
   *
   * @param content - The NWScript source code
   * @param position - Cursor position (0-indexed)
   * @param scopeType - The scope type to check for
   * @returns True if position is within the scope
   */
  public async isInScopeAST(content: string, position: Position, scopeType: string): Promise<boolean> {
    await this.tokenizeContent(content, TokenizedScope.global);

    if (!this.positionQuery) {
      return false;
    }

    return this.positionQuery.isInScope(position.line, position.character, scopeType);
  }

  /**
   * Get function name at cursor position using AST.
   * Used for signature help.
   *
   * @param content - The NWScript source code
   * @param position - Cursor position (0-indexed)
   * @returns Function name or undefined
   */
  public async getFunctionNameAtPositionAST(content: string, position: Position): Promise<string | undefined> {
    await this.tokenizeContent(content, TokenizedScope.global);

    if (!this.positionQuery) {
      return undefined;
    }

    return this.positionQuery.getFunctionNameAtPosition(position.line, position.character);
  }

  /**
   * Get active parameter index at cursor position using AST.
   * Used for signature help.
   *
   * @param content - The NWScript source code
   * @param position - Cursor position (0-indexed)
   * @returns Parameter index (0-based)
   */
  public async getActiveParameterIndexAST(content: string, position: Position): Promise<number> {
    await this.tokenizeContent(content, TokenizedScope.global);

    if (!this.positionQuery) {
      return 0;
    }

    return this.positionQuery.getActiveParameterIndex(position.line, position.character);
  }

  // ============================================================================
  // TEXTMATE-BASED TOKENIZATION (Legacy Position Queries)
  // ============================================================================
  // These methods use TextMate grammar for fine-grained position-based queries.
  // Kept for compatibility, prefer AST-based methods above.
  // Used for: LSP features like hover, autocomplete, signature help at cursor position

  /**
   * Tokenize content to raw TextMate tokens for position-based queries.
   *
   * @param content - The NWScript source code
   * @returns Tuple of [lines, token arrays per line]
   */

  public tokenizeContentToRaw(content: string): [lines: string[], rawTokenizedContent: (IToken[] | undefined)[]] {
    const lines = content.split(/\r?\n/);
    let ruleStack = INITIAL;

    return [
      lines,
      lines.map((line) => {
        const tokenizedLine = this.grammar?.tokenizeLine(line, ruleStack);
        if (tokenizedLine) {
          ruleStack = tokenizedLine.ruleStack;
        }
        return tokenizedLine?.tokens;
      }),
    ];
  }

  /**
   * Get the token at or near a specific position in the document.
   *
   * @param lines - Source code lines
   * @param tokensArrays - TextMate tokens per line
   * @param position - Cursor position
   * @param offset - Offset from position (-1 for previous token, 1 for next)
   * @returns Token information including type and content
   */

  public getActionTargetAtPosition(lines: string[], tokensArrays: (IToken[] | undefined)[], position: Position, offset: number = 0) {
    let tokenType;
    let lookBehindRawContent;

    const line = lines[position.line];
    const tokensArray = tokensArrays[position.line];

    if (!tokensArray) {
      return {
        tokenType,
        lookBehindRawContent,
        rawContent: undefined,
      };
    }

    const arrayLength = tokensArray.length;
    const tokenIndex = this.getTokenIndexAtPosition(tokensArray, position);

    if (tokenIndex + offset >= arrayLength || tokenIndex - Math.abs(offset) < 0) {
      return {
        tokenType,
        lookBehindRawContent,
        rawContent: undefined,
      };
    }

    const token = tokensArray[tokenIndex + offset];

    if (token.scopes.includes(LanguageScopes.structProperty)) {
      tokenType = CompletionItemKind.Property;
      lookBehindRawContent = this.getRawTokenContent(line, tokensArray[tokenIndex - 2]);
    } else if (token.scopes.includes(LanguageScopes.structIdentifier)) {
      tokenType = CompletionItemKind.Struct;
    } else if (token.scopes.includes(LanguageScopes.constantIdentifer)) {
      tokenType = CompletionItemKind.Constant;
    } else if (token.scopes.includes(LanguageScopes.functionIdentifier)) {
      tokenType = CompletionItemKind.Function;
    }

    return {
      tokenType,
      lookBehindRawContent,
      rawContent: this.getRawTokenContent(line, token),
    };
  }

  /**
   * Look backward from position to find content matching specific scopes.
   * Used for finding function names in signature help.
   *
   * @param line - The source line
   * @param tokensArray - TextMate tokens for this line
   * @param position - Starting position
   * @param languageScopes - Scopes to match (e.g., function identifier)
   * @returns The matched token content
   */
  public getLookBehindScopesRawContent(line: string, tokensArray: IToken[], position: Position, languageScopes: LanguageScopes[]) {
    let identifier: string | undefined;
    const tokenIndex = this.getTokenIndexAtPosition(tokensArray, position);

    for (let currentIndex = tokenIndex; currentIndex >= 0; currentIndex--) {
      const token = tokensArray[currentIndex];
      if (languageScopes.every((scope) => token.scopes.includes(scope))) {
        identifier = this.getRawTokenContent(line, token);
      }
    }

    return identifier;
  }

  /**
   * Count occurrences of a specific scope when looking backward from position.
   * Used for counting commas to determine active parameter in signature help.
   *
   * @param tokensArray - TextMate tokens for this line
   * @param position - Starting position
   * @param occurencesTarget - Scope to count (e.g., separator/comma)
   * @param delimiter - Scope to stop at (e.g., function call start)
   * @returns Number of occurrences found
   */

  public getLookBehindScopeOccurences(tokensArray: IToken[], position: Position, occurencesTarget: LanguageScopes, delimiter: LanguageScopes) {
    let occurences = 0;
    let currentIndex = this.getTokenIndexAtPosition(tokensArray, position);

    while (currentIndex >= 0 && !tokensArray[currentIndex].scopes.includes(delimiter)) {
      if (tokensArray[currentIndex].scopes.includes(occurencesTarget)) {
        occurences++;
      }
      currentIndex--;
    }

    return occurences;
  }

  /**
   * Check if a position is within a specific language scope.
   * Used for determining if cursor is inside a function call, etc.
   *
   * @param tokensArray - TextMate tokens for this line
   * @param position - Position to check
   * @param scope - Scope to check for (e.g., function call)
   * @returns True if position is in the specified scope
   */
  public isInScope(tokensArray: IToken[], position: Position, scope: LanguageScopes) {
    return this.getTokenAtPosition(tokensArray, position)?.scopes.includes(scope);
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  /**
   * Find the index of the token at a specific position.
   */
  private getTokenIndexAtPosition(tokensArray: IToken[], position: Position) {
    return tokensArray.findIndex((token) => token.startIndex <= position.character && token.endIndex >= position.character);
  }

  /**
   * Find the token at a specific position.
   */
  private getTokenAtPosition(tokensArray: IToken[], position: Position) {
    return tokensArray.find((token) => token.startIndex <= position.character && token.endIndex >= position.character);
  }

  /**
   * Extract the raw text content of a token.
   */
  private getRawTokenContent(line: string, token: IToken) {
    return line.slice(token.startIndex, token.endIndex);
  }
}
