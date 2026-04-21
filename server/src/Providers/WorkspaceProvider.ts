import type { ServerManager } from "../ServerManager";
import Provider from "./Provider";

export default class WorkspaceProvider extends Provider {
  constructor(server: ServerManager) {
    super(server);

    try {
      this.server.connection.workspace.onDidChangeWorkspaceFolders(() => {});
    } catch {
      // Client doesn't support workspace folder change events — safe to ignore
    }
    this.server.connection.onDidChangeWatchedFiles(() => {});
  }
}
