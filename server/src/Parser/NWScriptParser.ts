import { join } from "path";
import type { AST, ASTNode } from "./ASTTypes";

/**
 * WebAssembly-based NWScript parser
 * Uses the official NWScript compiler to generate AST
 */
export class NWScriptParser {
  private module: any = null;
  private initialized: boolean = false;

  /**
   * Initialize the WASM module
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const wasmPath = join(__dirname, "..", "..", "wasm", "nwscript_compiler.js");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const NWScriptCompiler = require(wasmPath);
    this.module = await NWScriptCompiler();
    this.initialized = true;
  }

  /**
   * Parse NWScript content and return the AST
   * @param content The NWScript source code
   * @param filename The name of the file being parsed (without extension)
   * @param includes Map of include filenames to their content
   * @returns The parsed AST or null if compilation failed
   */
  async parse(content: string, filename: string = "script", includes: Map<string, string> = new Map()): Promise<{ ast: AST | null; errors: string[] }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const errors: string[] = [];
    let compilerPtr: number | null = null;

    try {
      // Minimal NWScript specification
      const nwscriptSpec = this.getMinimalNWScriptSpec();
      const nwnxStub = this.getNWNXStub();

      // File resolver callback
      const resolverPtr = this.module.addFunction((filenamePtr: number, resType: number) => {
        try {
          const requestedFile = this.module.UTF8ToString(filenamePtr);
          let fileContent: string;

          if (requestedFile === "nwscript") {
            fileContent = nwscriptSpec;
          } else if (requestedFile === "nwnx") {
            fileContent = nwnxStub;
          } else if (includes.has(requestedFile)) {
            fileContent = includes.get(requestedFile)!;
          } else if (requestedFile === filename) {
            fileContent = content;
          } else {
            // Return empty content for unknown includes
            fileContent = "// Include stub";
          }

          const contentLen = this.module.lengthBytesUTF8(fileContent);
          // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
          const contentPtr = this.module._malloc(contentLen + 1);
          // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
          this.module.stringToUTF8(fileContent, contentPtr, contentLen + 1);

          this.module.ccall("scriptCompApiDeliverFile", null, ["number", "number", "number"], [compilerPtr, contentPtr, contentLen]);

          this.module._free(contentPtr);
          return 1; // Success
        } catch (error) {
          console.error("File resolver error:", error);
          return 0; // Failure
        }
      }, "iii");

      // Writer callback (not used for AST extraction)
      const writerPtr = this.module.addFunction(() => 0, "iiiiii");

      // Create compiler instance
      const newCompiler = this.module.cwrap("scriptCompApiNewCompiler", "number", ["number", "number", "number", "number", "number"]);
      compilerPtr = newCompiler(2009, 2010, 2064, writerPtr, resolverPtr);

      // Initialize compiler
      const initCompiler = this.module.cwrap("scriptCompApiInitCompiler", null, ["number", "string", "boolean", "number", "string", "string"]);
      initCompiler(compilerPtr, "nwscript", false, 16, "", "scriptout");

      // Compile the script
      const compileFileSimple = this.module.cwrap("scriptCompApiCompileFileSimple", "number", ["number", "string"]);
      const resultCode = compileFileSimple(compilerPtr, filename);

      if (resultCode !== 0) {
        const getLastError = this.module.cwrap("scriptCompApiGetLastError", "string", ["number"]);
        const error = getLastError(compilerPtr);
        errors.push(error);

        // Cleanup and return null AST
        const destroyCompiler = this.module.cwrap("scriptCompApiDestroyCompiler", null, ["number"]);
        destroyCompiler(compilerPtr);

        return { ast: null, errors };
      }

      // Get the AST as JSON
      const getParseTreeJSON = this.module.cwrap("scriptCompApiGetParseTreeJSON", "string", ["number"]);
      const jsonStr = getParseTreeJSON(compilerPtr);

      if (!jsonStr) {
        errors.push("Failed to get parse tree JSON");
        return { ast: null, errors };
      }

      const ast: AST = JSON.parse(jsonStr);

      // Cleanup
      const destroyCompiler = this.module.cwrap("scriptCompApiDestroyCompiler", null, ["number"]);
      destroyCompiler(compilerPtr);

      return { ast, errors: [] };
    } catch (error) {
      errors.push(`Parser error: ${String(error)}`);
      return { ast: null, errors };
    }
  }

  /**
   * Get minimal NWScript specification required for compilation
   */
  private getMinimalNWScriptSpec(): string {
    return `
#define ENGINE_NUM_STRUCTURES 0

int TRUE = 1;
int FALSE = 0;

// Common string functions
int GetStringLength(string s) { return 0; }
string GetStringRight(string s, int n) { return ""; }
string GetStringLeft(string s, int n) { return ""; }
int FindSubString(string s, string sub) { return -1; }
string GetSubString(string s, int start, int count) { return ""; }
string IntToString(int n) { return ""; }
int StringToInt(string s) { return 0; }
string FloatToString(float f, int width, int decimals) { return ""; }
float StringToFloat(string s) { return 0.0; }

// Common object functions
object GetFirstPC() { return OBJECT_INVALID; }
object GetNextPC() { return OBJECT_INVALID; }
object OBJECT_INVALID = 0;
object OBJECT_SELF = 1;

// Common utility functions
void PrintString(string s) {}
void PrintInteger(int n) {}
void PrintFloat(float f) {}
`;
  }

  /**
   * Get NWNX stub functions
   */
  private getNWNXStub(): string {
    return `
// NWNX stub functions for parsing
void NWNX_PushArgumentInt(int i) {}
void NWNX_PushArgumentFloat(float f) {}
void NWNX_PushArgumentString(string s) {}
void NWNX_PushArgumentObject(object o) {}
void NWNX_CallFunction(string plugin, string func) {}
int NWNX_GetReturnValueInt() { return 0; }
float NWNX_GetReturnValueFloat() { return 0.0; }
string NWNX_GetReturnValueString() { return ""; }
object NWNX_GetReturnValueObject() { return OBJECT_INVALID; }
`;
  }

  /**
   * Find a node at a specific position
   * @param ast The root AST node
   * @param line Line number (0-indexed in TypeScript, 1-indexed in AST)
   * @param character Character position
   * @returns The node at the position or null
   */
  findNodeAtPosition(ast: ASTNode, line: number, character: number): ASTNode | null {
    const targetLine = line + 1; // Convert to 1-indexed

    function traverse(node: ASTNode | null): ASTNode | null {
      if (!node) return null;

      // Check if this node contains the position
      if (node.position.line === targetLine && node.position.char <= character) {
        // This node might be it, but check children first for more specific match
        const leftResult = traverse(node.left);
        if (leftResult) return leftResult;

        const rightResult = traverse(node.right);
        if (rightResult) return rightResult;

        // No better match in children, return this node
        return node;
      }

      // Check children even if this node doesn"t match
      const leftResult = traverse(node.left);
      if (leftResult) return leftResult;

      return traverse(node.right);
    }

    return traverse(ast);
  }
}

/**
 * Singleton instance of the parser
 */
let parserInstance: NWScriptParser | null = null;

/**
 * Get the singleton parser instance
 */
export async function getParser(): Promise<NWScriptParser> {
  if (!parserInstance) {
    parserInstance = new NWScriptParser();
    await parserInstance.initialize();
  }
  return parserInstance;
}
