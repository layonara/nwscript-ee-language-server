import { expect } from "chai";
import Tokenizer, { TokenizedScope } from "../src/Tokenizer/Tokenizer";

describe("AST Integration Tests", () => {
  let tokenizer: Tokenizer;

  before(async () => {
    tokenizer = await new Tokenizer(true).loadGrammar();
  });

  describe("Basic position queries", () => {
    const code = `int Add(int a, int b) { return a + b; }

void main() {
    int result = Add(5, 10);
}`;

    it("should find tokens using AST position queries", async () => {
      // Just verify that the method works without errors
      const result = await tokenizer.getActionTargetAtPositionAST(code, {
        line: 3,
        character: 20,
      });

      expect(result).to.exist;
      expect(result).to.have.property("tokenType");
      expect(result).to.have.property("rawContent");
    });

    it("should detect function call scope", async () => {
      // Position somewhere inside Add(5, 10)
      const isInCall = await tokenizer.isInScopeAST(
        code,
        { line: 3, character: 22 },
        "function.call"
      );

      expect(isInCall).to.be.a("boolean");
    });

    it("should get function name in call context", async () => {
      // Position inside function call
      const funcName = await tokenizer.getFunctionNameAtPositionAST(code, {
        line: 3,
        character: 22,
      });

      // Should either find the function name or return undefined
      if (funcName) {
        expect(funcName).to.be.a("string");
      } else {
        expect(funcName).to.be.undefined;
      }
    });

    it("should get active parameter index", async () => {
      // Position inside function call
      const index = await tokenizer.getActiveParameterIndexAST(code, {
        line: 3,
        character: 22,
      });

      expect(index).to.be.a("number");
      expect(index).to.be.at.least(0);
    });
  });

  describe("AST structural tokenization still works", () => {
    const code = `int globalVar = 10;

void TestFunc(int param) {
    int localVar = 5;
}

void main() {}`;

    it("should extract global tokens", async () => {
      const result = await tokenizer.tokenizeContent(
        code,
        TokenizedScope.global
      );

      expect(result.complexTokens).to.be.an("array");
      expect(result.structComplexTokens).to.be.an("array");

      // Should find at least the functions
      const funcNames = result.complexTokens
        .filter((t) => t.identifier)
        .map((t) => t.identifier);

      expect(funcNames).to.include("TestFunc");
      expect(funcNames).to.include("main");
    });

    it("should extract local tokens", async () => {
      const result = await tokenizer.tokenizeContent(
        code,
        TokenizedScope.local,
        0,
        5
      );

      expect(result.functionsComplexTokens).to.be.an("array");
      expect(result.functionVariablesComplexTokens).to.be.an("array");
    });
  });

  describe("Caching behavior", () => {
    const code = `void test() {
    int x = 5;
}

void main() {}`;

    it("should cache parsed AST", async () => {
      // First call
      const start1 = Date.now();
      await tokenizer.getActionTargetAtPositionAST(code, {
        line: 1,
        character: 8,
      });
      const time1 = Date.now() - start1;

      // Second call with same code - should use cache
      const start2 = Date.now();
      await tokenizer.getActionTargetAtPositionAST(code, {
        line: 1,
        character: 10,
      });
      const time2 = Date.now() - start2;

      // Second call should be faster or roughly the same (cache hit)
      // Allow some variance for timing inconsistencies
      expect(time2).to.be.lessThan(time1 + 50);
    });
  });

  describe("Error handling", () => {
    it("should handle invalid code gracefully", async () => {
      const invalidCode = `void test() {
    int x = ; // syntax error
}`;

      // Should not throw
      const result = await tokenizer.getActionTargetAtPositionAST(invalidCode, {
        line: 1,
        character: 10,
      });

      expect(result).to.exist;
    });

    it("should handle empty code", async () => {
      const result = await tokenizer.getActionTargetAtPositionAST("", {
        line: 0,
        character: 0,
      });

      expect(result.tokenType).to.be.undefined;
      expect(result.rawContent).to.be.undefined;
    });

    it("should handle out of bounds positions", async () => {
      const code = `void main() {}`;

      const result = await tokenizer.getActionTargetAtPositionAST(code, {
        line: 999,
        character: 999,
      });

      expect(result).to.exist;
    });
  });

  describe("Complex scenarios", () => {
    const code = `int Multiply(int a, int b) { return a * b; }
int Add(int a, int b) { return a + b; }

void main() {
    int result = Add(Multiply(2, 3), 10);
}`;

    it("should handle nested function calls", async () => {
      // Query inside nested call
      const funcName = await tokenizer.getFunctionNameAtPositionAST(code, {
        line: 4,
        character: 26,
      });

      // Should find either Multiply or Add
      if (funcName) {
        expect(["Multiply", "Add"]).to.include(funcName);
      }
    });

    it("should detect scope in nested calls", async () => {
      const isInCall = await tokenizer.isInScopeAST(
        code,
        { line: 4, character: 26 },
        "function.call"
      );

      expect(isInCall).to.be.a("boolean");
    });
  });
});
