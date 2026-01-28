import { CompletionItemKind, HoverParams, Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import type { ServerManager } from "../ServerManager";
import type { ComplexToken } from "../Tokenizer/types";
import { HoverContentBuilder } from "./Builders";
import { Document } from "../Documents";
import Provider from "./Provider";
import { TokenizedScope } from "../Tokenizer/Tokenizer";

export default class HoverContentProvider extends Provider {
  constructor(server: ServerManager) {
    super(server);

    this.server.connection.onHover((params) => this.exceptionsWrapper(this.providerHandler(params)));
  }

  private providerHandler(params: HoverParams) {
    return async () => {
      const {
        textDocument: { uri },
        position,
      } = params;

      const liveDocument = this.server.liveDocumentsManager.get(uri);
      const document = this.server.documentsCollection.getFromUri(uri);
      if (!liveDocument || !document) return;

      const token = await this.resolveToken(position, document, liveDocument);

      if (token) {
        return {
          contents: HoverContentBuilder.buildItem(token, this.server.config),
        };
      }
    };
  }

  private async resolveToken(position: Position, document: Document, liveDocument: TextDocument) {
    let tokens;
    let token: ComplexToken | undefined;

    const content = liveDocument.getText();
    const localScope = await this.server.tokenizer.tokenizeContent(content, TokenizedScope.local, 0, position.line);
    const { tokenType, lookBehindRawContent, rawContent } = await this.server.tokenizer.getActionTargetAtPositionAST(content, position);

    switch (tokenType) {
      case CompletionItemKind.Function:
      case CompletionItemKind.Constant:
        token = localScope.functionsComplexTokens.find((candidate) => candidate.identifier === rawContent);
        if (token) break;

        tokens = document.getGlobalComplexTokens();
        token = tokens.find((candidate) => candidate.identifier === rawContent);
        if (token) break;

        tokens = this.server.documentsCollection.standardLibComplexTokens;
        token = tokens.find((candidate) => candidate.identifier === rawContent);
        break;
      case CompletionItemKind.Struct:
        tokens = document.getGlobalStructComplexTokens();
        token = tokens.find((candidate) => candidate.identifier === rawContent);
        break;
      case CompletionItemKind.Property: {
        const structIdentifer = localScope?.functionVariablesComplexTokens.find((candidate) => candidate.identifier === lookBehindRawContent)?.valueType;

        token = document
          .getGlobalStructComplexTokens()
          .find((candidate) => candidate.identifier === structIdentifer)
          ?.properties.find((property) => property.identifier === rawContent);
        break;
      }
      default:
        token = localScope.functionVariablesComplexTokens.find((candidate) => candidate.identifier === rawContent);
    }

    return token;
  }
}
