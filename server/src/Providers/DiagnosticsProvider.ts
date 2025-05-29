import { spawn } from "child_process";
import { type, tmpdir } from "os";
import { join, dirname, basename, parse } from "path";
import { fileURLToPath } from "url";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import fs from "fs";

import { ServerManager } from "../ServerManager";
import Provider from "./Provider";

const lineNumber = /\(([^)]+)\)/;
const lineMessage = /(ERROR|WARNING):(.*)/;
const lineFilename = /(:\s)([^(]+)/;

enum OS {
  linux = "Linux",
  mac = "Darwin",
  windows = "Windows_NT",
}

type FilesDiagnostics = { [uri: string]: Diagnostic[] };
export default class DiagnoticsProvider extends Provider {
  constructor(server: ServerManager) {
    super(server);
  }

  private generateDiagnostics(originalFilePath: string, uris: string[], files: FilesDiagnostics, severity: DiagnosticSeverity) {
    return (line: string) => {
      const originalFileNoExt = parse(originalFilePath).name; // extracts the name portion without an extension
      const lineFilenameMatch = lineFilename.exec(line);
      if (lineFilenameMatch) {
        let reportedFileName = lineFilenameMatch[2];
        const isTempFile = reportedFileName === `${originalFileNoExt}_temp.nss`;

        // If it's the temp file, map it back to the original
        if (isTempFile) {
          reportedFileName = `${originalFileNoExt}.nss`;
        }
        
        const uri = uris.find((uri) => basename(fileURLToPath(uri)) === reportedFileName);
        if (uri) {
          let linePosition = Number(lineNumber.exec(line)![1]) - 1;
          linePosition = isTempFile ? linePosition - 1 : linePosition; // -1 again to account for the void main we intruduced
          const diagnostic = {
            severity,
            range: {
              start: { line: linePosition, character: 0 },
              end: { line: linePosition, character: Number.MAX_VALUE },
            },
            message: lineMessage.exec(line)![2].trim(),
          };

          files[uri].push(diagnostic);
        }
      } else {
        const uri = uris.find((uri) => basename(fileURLToPath(uri)) === lineFilename.exec(line)![2]);

        if (uri) {
          const linePosition = Number(lineNumber.exec(line)![1]) - 1;
          const diagnostic = {
            severity,
            range: {
              start: { line: linePosition, character: 0 },
              end: { line: linePosition, character: Number.MAX_VALUE },
            },
            message: lineMessage.exec(line)![2].trim(),
          };

          files[uri].push(diagnostic);
        }
      }
    };
  }

  private hasSupportedOS() {
    return ([...Object.values(OS).filter((item) => isNaN(Number(item)))] as string[]).includes(type());
  }

  private getExecutablePath(os: OS | null) {
    const specifiedOs = os || type();

    switch (specifiedOs) {
      case OS.linux:
        return "../resources/compiler/linux/nwn_script_comp";
      case OS.mac:
        return "../resources/compiler/mac/nwn_script_comp";
      case OS.windows:
        return "../resources/compiler/windows/nwn_script_comp.exe";
      default:
        return "";
    }
  }

  public publish(uri: string) {
    return new Promise<boolean>((resolve, reject) => {
      const { enabled, nwnHome, reportWarnings, nwnInstallation, verbose, os } = this.server.config.compiler;
      if (!enabled || uri.includes("nwscript.nss")) {
        return resolve(true);
      }

      if (!this.hasSupportedOS()) {
        const errorMessage = "Unsupported OS. Cannot provide diagnostics.";
        this.server.logger.error(errorMessage);
        return reject(new Error(errorMessage));
      }

      const document = this.server.documentsCollection.getFromUri(uri);

      if (!this.server.configLoaded || !document) {
        if (!this.server.documentsWaitingForPublish.includes(uri)) {
          this.server.documentsWaitingForPublish.push(uri);
        }
        return resolve(true);
      }

      const children = document.getChildren();
      const files: FilesDiagnostics = { [document.uri]: [] };
      const uris: string[] = [];
      children.forEach((child) => {
        const fileUri = this.server.documentsCollection.get(child)?.uri;
        if (fileUri) {
          files[fileUri] = [];
          uris.push(fileUri);
        }
      });

      if (verbose) {
        this.server.logger.info(`Compiling ${document.uri}:`);
      }
      // The compiler command:
      //  - y; continue on error
      //  - s; dry run
      const args = ["-y", "-s"];
      if (Boolean(nwnHome)) {
        args.push("--userdirectory");
        args.push(`"${nwnHome}"`);
      } else if (verbose) {
        this.server.logger.info("Trying to resolve Neverwinter Nights home directory automatically.");
      }
      if (Boolean(nwnInstallation)) {
        args.push("--root");
        args.push(`"${nwnInstallation}"`);
      } else if (verbose) {
        this.server.logger.info("Trying to resolve Neverwinter Nights installation directory automatically.");
      }
      if (children.length > 0) {
        const directories = [...new Set(uris.map((uri) => dirname(fileURLToPath(uri))))];

        // Ensure trailing slashes
        const dirsWithSlash = directories.map(p => p.endsWith("\\") ? p : p + "\\");

        // Wrap each in escaped quotes, join by comma
        const dirsArg = dirsWithSlash.map(p => `"${p}"`).join(',');
        // Each directory is wrapped in quotes, then joined with commas
        args.push("--dirs");
        args.push(dirsArg);
      }

      const filePath = fileURLToPath(uri);
      const fileContent = fs.readFileSync(filePath, "utf8");
      const hasVoidMain = fileContent.includes("void main");

      let compilePath = filePath; // default to original

      if (!hasVoidMain) {
        this.server.logger.info(`Adding void main to ${filePath} for compilation.`);
        const lines = fileContent.split("\n");
        lines.splice(0, 0, "void main() {}");

        const originalFileNoExt = parse(filePath).name;
        const tempFileName = `${originalFileNoExt}_temp.nss`;
        const tempFilePath = join(tmpdir(), tempFileName);
        this.server.logger.info(`Writing temporary file to ${tempFilePath}`);
        fs.writeFileSync(tempFilePath, lines.join("\n"), "utf8");
        compilePath = tempFilePath;
      }

      this.server.logger.info(`Compiling file: ${compilePath}`);
      args.push("-c");
      args.push(`"${compilePath}"`);

      let stdout = "";
      let stderr = "";

      if (verbose) {
        this.server.logger.info(this.getExecutablePath(os));
        this.server.logger.info(JSON.stringify(args, null, 4));
      }

      const child = spawn(join(__dirname, this.getExecutablePath(os)), args, { shell: 'powershell.exe' });

      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      child.on("error", (e: any) => {
        this.server.logger.error(e.message);
        reject(e);
      });

      child.on("close", (_) => {
        const lines = stderr
          .toString()
          .split("\n")
          .filter((line) => line !== "\r" && line !== "\n" && Boolean(line));
        const errors: string[] = [];
        const warnings: string[] = [];

        lines.forEach((line) => {
          if (verbose) {
            this.server.logger.info(line);
          }

          // Diagnostics
          if (line.includes("ERROR:")) {
            errors.push(line);
          }

          if (reportWarnings && line.includes("WARNING:")) {
            warnings.push(line);
          }

          // Actual errors
          if (line.includes("unhandled exception")) {
            this.server.logger.error(line);
          }

          if (line.includes("Could not locate")) {
            if (Boolean(nwnHome) || Boolean(nwnInstallation)) {
              return this.server.logger.error("Unable to resolve provided Neverwinter Nights home and/or installation directories. Ensure the paths are valid in the extension settings.");
            } else {
              return this.server.logger.error("Unable to automatically resolve Neverwinter Nights home and/or installation directories.");
            }
          }
        });

        if (verbose) {
          this.server.logger.info("Done.\n");
        }

        uris.push(document.uri);
        errors.forEach(this.generateDiagnostics(filePath, uris, files, DiagnosticSeverity.Error));
        if (reportWarnings) warnings.forEach(this.generateDiagnostics(filePath, uris, files, DiagnosticSeverity.Warning));

        for (const [uri, diagnostics] of Object.entries(files)) {
          this.server.connection.sendDiagnostics({ uri, diagnostics });
        }

        if (!hasVoidMain) {
          try {
            fs.unlinkSync(compilePath);
          } catch {
            this.server.logger.error(`Failed to delete temporary file: ${compilePath}`);
          }
        }

        resolve(true);
      });
    });
  }

  public async processDocumentsWaitingForPublish() {
    return await Promise.all(this.server.documentsWaitingForPublish.map(async (uri) => await this.publish(uri)));
  }
}
