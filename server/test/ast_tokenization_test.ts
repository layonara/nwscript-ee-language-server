/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, before, it } from "mocha";
import { expect } from "chai";
import Tokenizer, { TokenizedScope, GlobalScopeTokenizationResult, LocalScopeTokenizationResult } from "../src/Tokenizer/Tokenizer";
import { CompletionItemKind } from "vscode-languageserver";
import type { ConstantComplexToken, FunctionComplexToken, VariableComplexToken } from "../src/Tokenizer/types";

describe("AST Tokenization", () => {
  let astTokenizer: Tokenizer;

  before("Initialize tokenizers", async () => {
    astTokenizer = await new Tokenizer(true).loadGrammar();
  });

  describe("Simple script parsing", () => {
    const simpleScript = `
// Simple test script
int MAX_VALUE = 100;
string TEST_NAME = "test";

struct TestStruct {
    int id;
    string name;
};

int Add(int a, int b) {
    return a + b;
}

void main() {
    int x = 5;
    int y = 10;
    int result = Add(x, y);
}
`;

    it("should successfully parse with AST mode", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.global);

      expect(result).to.not.be.undefined;
      expect(result.complexTokens).to.be.an("array");
      expect(result.structComplexTokens).to.be.an("array");
    });

    it("should extract constants", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.global);

      const constants = result.complexTokens.filter((t) => t.tokenType === CompletionItemKind.Constant) as ConstantComplexToken[];
      expect(constants.length).to.be.at.least(2);

      const maxValue = constants.find((c) => c.identifier === "MAX_VALUE");
      expect(maxValue).to.not.be.undefined;
      expect(maxValue?.valueType).to.equal("int");

      const testName = constants.find((c) => c.identifier === "TEST_NAME");
      expect(testName).to.not.be.undefined;
      expect(testName?.valueType).to.equal("string");
    });

    it("should extract struct definitions", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.global);

      expect(result.structComplexTokens.length).to.be.at.least(1);

      const testStruct = result.structComplexTokens.find((s) => s.identifier === "TestStruct");
      expect(testStruct).to.not.be.undefined;
      expect(testStruct?.properties.length).to.be.at.least(2);

      const idProp = testStruct?.properties.find((p) => p.identifier === "id");
      expect(idProp).to.not.be.undefined;
      expect(idProp?.valueType).to.equal("int");

      const nameProp = testStruct?.properties.find((p) => p.identifier === "name");
      expect(nameProp).to.not.be.undefined;
      expect(nameProp?.valueType).to.equal("string");
    });

    it("should extract function declarations", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.global);

      const functions = result.complexTokens.filter((t) => t.tokenType === CompletionItemKind.Function) as FunctionComplexToken[];
      expect(functions.length).to.be.at.least(2);

      const addFunc = functions.find((f) => f.identifier === "Add");
      expect(addFunc).to.not.be.undefined;
      expect(addFunc?.returnType).to.equal("int");

      const mainFunc = functions.find((f) => f.identifier === "main");
      expect(mainFunc).to.not.be.undefined;
      expect(mainFunc?.returnType).to.equal("void");
    });

    it("should extract function parameters", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.global);

      const functions = result.complexTokens.filter((t) => t.tokenType === CompletionItemKind.Function) as FunctionComplexToken[];
      const addFunc = functions.find((f) => f.identifier === "Add");

      expect(addFunc).to.not.be.undefined;
      expect(addFunc?.params.length).to.equal(2);

      const paramA = addFunc?.params.find((p: any) => p.identifier === "a");
      expect(paramA).to.not.be.undefined;
      expect(paramA?.valueType).to.equal("int");

      const paramB = addFunc?.params.find((p: any) => p.identifier === "b");
      expect(paramB).to.not.be.undefined;
      expect(paramB?.valueType).to.equal("int");
    });

    it("should extract local scope variables", async () => {
      const result: LocalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.local);

      expect(result.functionVariablesComplexTokens).to.be.an("array");
      expect(result.functionVariablesComplexTokens.length).to.be.at.least(3);

      const xVar = result.functionVariablesComplexTokens.find((v) => v.identifier === "x") as VariableComplexToken | undefined;
      expect(xVar).to.not.be.undefined;
      expect(xVar?.valueType).to.equal("int");

      const yVar = result.functionVariablesComplexTokens.find((v) => v.identifier === "y");
      expect(yVar).to.not.be.undefined;

      const resultVar = result.functionVariablesComplexTokens.find((v) => v.identifier === "result");
      expect(resultVar).to.not.be.undefined;
    });

    it("should extract local scope functions", async () => {
      const result: LocalScopeTokenizationResult = await astTokenizer.tokenizeContent(simpleScript, TokenizedScope.local);

      expect(result.functionsComplexTokens).to.be.an("array");
      const addFunc = result.functionsComplexTokens.find((f) => f.identifier === "Add");
      expect(addFunc).to.not.be.undefined;
    });
  });

  describe("Position accuracy", () => {
    const positionScript = `void testFunction() {
    int x = 5;
}

void main() {}`;

    it("should have accurate line numbers (0-indexed)", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(positionScript, TokenizedScope.global);

      const func = result.complexTokens.find((t) => t.identifier === "testFunction");
      expect(func).to.not.be.undefined;
      expect(func?.position.line).to.equal(0); // First line, 0-indexed
    });

    it("should have accurate character positions", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(positionScript, TokenizedScope.global);

      const func = result.complexTokens.find((t) => t.identifier === "testFunction");
      expect(func).to.not.be.undefined;
      expect(func?.position.character).to.be.greaterThan(0);
    });
  });

  describe("Complex expressions", () => {
    const complexScript = `
int Calculate() {
    int a = 5 + 3;
    int b = a * 2;
    int c = (b - 1) / 2;
    return c;
}

void TestLogic() {
    int x = 10;
    if (x > 5) {
        x = x + 1;
    }
}

void main() {}
`;

    it("should handle complex expressions", async () => {
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(complexScript, TokenizedScope.global);

      expect(result.complexTokens.length).to.be.at.least(2);

      const calcFunc = result.complexTokens.find((f) => f.identifier === "Calculate") as FunctionComplexToken | undefined;
      expect(calcFunc).to.not.be.undefined;
      expect(calcFunc?.returnType).to.equal("int");
    });

    it("should extract variables from complex functions", async () => {
      const result: LocalScopeTokenizationResult = await astTokenizer.tokenizeContent(complexScript, TokenizedScope.local);

      const variables = result.functionVariablesComplexTokens;
      expect(variables.length).to.be.at.least(4); // a, b, c, x

      const varA = variables.find((v) => v.identifier === "a") as VariableComplexToken | undefined;
      expect(varA).to.not.be.undefined;
      expect(varA?.valueType).to.equal("int");
    });
  });

  describe("Error handling", () => {
    const invalidScript = `
void main() {
    UndefinedFunction();
}`;

    it("should return empty results on parse errors", async () => {
      // AST parsing will fail for invalid code, returns empty results
      const result: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(invalidScript, TokenizedScope.global);

      expect(result).to.not.be.undefined;
      expect(result.complexTokens).to.be.an("array");
      expect(result.complexTokens.length).to.equal(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle multi-line function declarations", async () => {
      const edgeCaseScript = `
// Multi-line function declaration
int
VeryLongFunctionName
(
    int parameter
)
{
    return parameter;
}

void main() {}
`;

      const astResult: GlobalScopeTokenizationResult = await astTokenizer.tokenizeContent(edgeCaseScript, TokenizedScope.global);

      // AST should find the function
      const func = astResult.complexTokens.find((t) => t.identifier === "VeryLongFunctionName") as FunctionComplexToken | undefined;
      expect(func).to.not.be.undefined;
      expect(func?.returnType).to.equal("int");
    });
  });

  describe("Performance", () => {
    it("should cache AST for repeated calls", async () => {
      const script = "void main() { int x = 5; }";

      const start1 = Date.now();
      await astTokenizer.tokenizeContent(script, TokenizedScope.global);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      await astTokenizer.tokenizeContent(script, TokenizedScope.global);
      const time2 = Date.now() - start2;

      // Second call should be faster (cached)
      expect(time2).to.be.lessThan(time1);
    });
  });
});
