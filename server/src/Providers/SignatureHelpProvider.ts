import { SignatureHelpParams } from "vscode-languageserver/node";

import type { ServerManager } from "../ServerManager";
import type { FunctionComplexToken } from "../Tokenizer/types";
import { LanguageScopes } from "../Tokenizer/constants";
import { TokenizedScope } from "../Tokenizer/Tokenizer";
import { SignatureHelpBuilder } from "./Builders";
import Provider from "./Provider";

export default class SignatureHelpProvider extends Provider {
  constructor(server: ServerManager) {
    super(server);

    this.server.connection.onSignatureHelp((params) => this.exceptionsWrapper(this.providerHandler(params)));
  }

  private providerHandler(params: SignatureHelpParams) {
    return async () => {
      const {
        textDocument: { uri },
        position,
      } = params;

      const liveDocument = this.server.liveDocumentsManager.get(uri);
      const document = this.server.documentsCollection.getFromUri(uri);
      if (!liveDocument || !document) return;

      const content = liveDocument.getText();

      // Use AST-based position queries instead of TextMate
      const isInFunctionCall = await this.server.tokenizer.isInScopeAST(content, position, "function.call");
      if (!isInFunctionCall) return;

      const rawContent = await this.server.tokenizer.getFunctionNameAtPositionAST(content, position);
      const activeParameter = await this.server.tokenizer.getActiveParameterIndexAST(content, position);

      const localScope = await this.server.tokenizer.tokenizeContent(content, TokenizedScope.local, 0, position.line);
      const functionComplexToken =
        localScope.functionsComplexTokens.find((token) => token.identifier === rawContent) ||
        document.getGlobalComplexTokens().find((token) => token.identifier === rawContent) ||
        this.getStandardLibComplexTokens().find((token) => token.identifier === rawContent);

      if (functionComplexToken) {
        return SignatureHelpBuilder.buildFunctionItem(functionComplexToken as FunctionComplexToken, activeParameter);
      }
    };
  }
}
