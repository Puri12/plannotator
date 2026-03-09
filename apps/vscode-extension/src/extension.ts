import * as vscode from "vscode";
import * as path from "path";
import { createIpcServer } from "./ipc-server";
import { createCookieProxy } from "./cookie-proxy";
import { PanelManager } from "./panel-manager";
import { setActiveProxyPort, registerEditorAnnotationCommand } from "./editor-annotations";

const COOKIE_KEY = "plannotator-cookies";

const log = vscode.window.createOutputChannel("Plannotator", { log: true });

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const panelManager = new PanelManager();
  panelManager.setExtensionPath(context.extensionPath);

  const openInPanel = async (url: string) => {
    log.info(`[open] received url: ${url}`);

    // Each panel gets its own cookie proxy so multiple agents
    // can point to different upstream servers without conflicts.
    const proxy = await createCookieProxy({
      loadCookies: () => {
        const cookies = context.globalState.get<string>(COOKIE_KEY) ?? "";
        log.info(`[load] ${cookies.length} chars: ${cookies.slice(0, 120)}…`);
        return cookies;
      },
      onSaveCookies: (cookies) => {
        log.info(`[save] ${cookies.length} chars: ${cookies.slice(0, 120)}…`);
        context.globalState.update(COOKIE_KEY, cookies);
      },
      onClose: () => {
        log.info("[close] received close signal from plannotator");
      },
    });

    const panel = await panelManager.open(proxy.rewriteUrl(url));
    setActiveProxyPort(proxy.port);

    // Auto-close this specific panel when plannotator signals completion
    proxy.events.on("close", () => panel.dispose());

    // Clean up proxy server and editor annotations state when the panel is closed
    panel.onDidDispose(() => {
      proxy.server.close();
      setActiveProxyPort(null);
    });

    vscode.window.showInformationMessage("Plannotator panel opened");
  };

  // Start local IPC server to receive URLs from the router script.
  // Reuse the last port so restored terminals still have a valid PLANNOTATOR_VSCODE_PORT.
  const lastPort = context.workspaceState.get<number>("ipcPort");
  const { server, port } = await createIpcServer((url) => {
    openInPanel(url).catch((err) => {
      log.error(`[open] failed: ${err}`);
      vscode.window.showErrorMessage(`Plannotator: ${err}`);
    });
  }, lastPort);
  context.workspaceState.update("ipcPort", port);
  context.subscriptions.push({ dispose: () => server.close() });

  // Inject env vars into integrated terminals
  const config = vscode.workspace.getConfiguration("plannotatorWebview");
  const injectBrowser = config.get("injectBrowser", true) as boolean;

  if (injectBrowser) {
    const binDir = path.join(context.extensionPath, "bin");
    const routerPath = path.join(binDir, "open-in-vscode");
    context.environmentVariableCollection.replace(
      "PLANNOTATOR_BROWSER",
      routerPath,
    );
    context.environmentVariableCollection.replace(
      "PLANNOTATOR_VSCODE_PORT",
      String(port),
    );
    context.environmentVariableCollection.prepend(
      "PATH",
      binDir + path.delimiter,
    );
  }

  // Register command for manual URL opening
  const openCommand = vscode.commands.registerCommand(
    "plannotator-webview.openUrl",
    async () => {
      const url = await vscode.window.showInputBox({
        prompt: "Enter the Plannotator URL to open",
        placeHolder: "http://localhost:3000",
      });
      if (url) {
        openInPanel(url).catch((err) => {
          log.error(`[open] failed: ${err}`);
          vscode.window.showErrorMessage(`Plannotator: ${err}`);
        });
      }
    },
  );
  context.subscriptions.push(openCommand);

  // Register editor annotation command
  registerEditorAnnotationCommand(context, log);
}

export function deactivate(): void {}
