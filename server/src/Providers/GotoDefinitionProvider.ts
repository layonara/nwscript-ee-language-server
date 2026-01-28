import { CompletionItemKind, DefinitionParams, Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import type { OwnedComplexTokens, OwnedStructComplexTokens } from "../Documents/Document";
import type { ServerManager } from "../ServerManager";
import type { ComplexToken } from "../Tokenizer/types";
import { Document } from "../Documents";
import Provider from "./Provider";
import { TokenizedScope } from "../Tokenizer/Tokenizer";

export default class GotoDefinitionProvider extends Provider {
  constructor(server: ServerManager) {
    super(server);

    this.server.connection.onDefinition((params) => this.exceptionsWrapper(this.providerHandler(params)));
  }

  private providerHandler(params: DefinitionParams) {
    return async () => {
      const {
        textDocument: { uri },
        position,
      } = params;

      const liveDocument = this.server.liveDocumentsManager.get(uri);
      const document = this.server.documentsCollection.getFromUri(uri);
      if (!liveDocument || !document) return;

      const [token, ref] = await this.resolveTokenAndRef(position, document, liveDocument);

      if (token) {
        if (ref && !ref.owner) {
          return {
            uri,
            range: {
              start: { line: position.line, character: position.character },
              end: { line: position.line, character: position.character },
            },
          };
        }

        return {
          uri: ref ? ref.owner || "" : uri,
          range: {
            start: { line: token.position.line, character: token.position.character },
            end: { line: token.position.line, character: token.position.character },
          },
        };
      }
    };
  }

  private async resolveTokenAndRef(
    position: Position,
    document: Document,
    liveDocument: TextDocument,
  ): Promise<[token: ComplexToken | undefined, ref: OwnedComplexTokens | OwnedStructComplexTokens | undefined]> {
    let tokensWithRef;
    let token: ComplexToken | undefined;
    let ref: OwnedComplexTokens | OwnedStructComplexTokens | undefined;

    const content = liveDocument.getText();
    const localScope = await this.server.tokenizer.tokenizeContent(content, TokenizedScope.local, 0, position.line);
    const { tokenType, lookBehindRawContent, rawContent } = await this.server.tokenizer.getActionTargetAtPositionAST(content, position);

    switch (tokenType) {
      case CompletionItemKind.Function:
      case CompletionItemKind.Constant: {
        token = localScope.functionsComplexTokens.find((candidate) => candidate.identifier === rawContent);
        if (token) break;

        const localStandardLibDefinitions = this.server.documentsCollection.get("nwscript");
        tokensWithRef = document.getGlobalComplexTokensWithRef();

        if (localStandardLibDefinitions) {
          tokensWithRef.push({ owner: localStandardLibDefinitions?.uri, tokens: localStandardLibDefinitions?.complexTokens });
        }

        for (let i = 0; i < tokensWithRef.length; i++) {
          ref = tokensWithRef[i];

          token = ref?.tokens.find((candidate) => candidate.identifier === rawContent);
          if (token) {
            break;
          }
        }
        break;
      }
      case CompletionItemKind.Struct: {
        tokensWithRef = document.getGlobalStructComplexTokensWithRef();
        for (let i = 0; i < tokensWithRef.length; i++) {
          ref = tokensWithRef[i];

          token = ref?.tokens.find((candidate) => candidate.identifier === rawContent);
          if (token) {
            break;
          }
        }
        break;
      }
      case CompletionItemKind.Property: {
        const structIdentifer = localScope.functionVariablesComplexTokens.find((candidate) => candidate.identifier === lookBehindRawContent)?.valueType;

        tokensWithRef = document.getGlobalStructComplexTokensWithRef();
        for (let i = 0; i < tokensWithRef.length; i++) {
          ref = tokensWithRef[i];

          token = (ref as OwnedStructComplexTokens).tokens.find((candidate) => candidate.identifier === structIdentifer)?.properties.find((property) => property.identifier === rawContent);

          if (token) {
            break;
          }
        }
        break;
      }
      default:
        token = localScope.functionVariablesComplexTokens.find((candidate) => candidate.identifier === rawContent);
    }

    return [token, ref];
  }
}
