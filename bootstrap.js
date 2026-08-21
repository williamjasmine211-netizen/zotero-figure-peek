/* global Zotero, Services, APP_SHUTDOWN */

var FigurePeekInstance = null;
var FigurePeekContext = null;

function install() {}

async function startup(data) {
  await Zotero.initializationPromise;

  const rawRoot = data.rootURI || data.resourceURI;
  let rootURI = typeof rawRoot === "string" ? rawRoot : rawRoot.spec;
  if (!rootURI.endsWith("/")) {
    rootURI += "/";
  }

  FigurePeekContext = {
    Zotero,
    Services,
    rootURI,
    pluginID: data.id,
    setTimeout,
    clearTimeout,
  };
  FigurePeekContext.globalThis = FigurePeekContext;
  FigurePeekContext._globalThis = FigurePeekContext;

  Services.scriptloader.loadSubScript(`${rootURI}core.js`, FigurePeekContext, "UTF-8");
  Services.scriptloader.loadSubScript(`${rootURI}figure-peek.js`, FigurePeekContext, "UTF-8");

  try {
    FigurePeekInstance = new FigurePeekContext.FigurePeekPlugin({
      Zotero,
      Services,
      pluginID: data.id,
      rootURI,
      core: FigurePeekContext.FigurePeekCore,
    });
    await FigurePeekInstance.start();
    Zotero.FigurePeek = FigurePeekInstance;
  }
  catch (error) {
    Zotero.logError(error);
    try {
      await FigurePeekInstance?.shutdown();
    }
    catch (shutdownError) {
      Zotero.logError(shutdownError);
    }
    FigurePeekInstance = null;
    FigurePeekContext = null;
    throw error;
  }
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  try {
    await FigurePeekInstance?.shutdown();
  }
  catch (error) {
    Zotero.logError(error);
  }
  if (Zotero.FigurePeek === FigurePeekInstance) {
    delete Zotero.FigurePeek;
  }
  FigurePeekInstance = null;
  FigurePeekContext = null;
}

function uninstall() {}
