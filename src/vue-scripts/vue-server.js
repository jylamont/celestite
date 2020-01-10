// Utility function to handle exit on error
const _exit = m => {
  console.error(m);
  process.exit(1);
};

// Core imports
import { resolve as _resolve, parse } from "path";
import fs from "fs";
import { Server } from "http";
import express from "express";
import { createBundleRenderer } from "vue-server-renderer";

// Webpack-related imports.
import webpack from "webpack";
import merge from "webpack-merge";
import webpackDevMiddleware from "webpack-dev-middleware";
import webpackHotMiddleware from "webpack-hot-middleware";
import webpackServerConfig from "config/webpack/webpack-vue-server-cfg.js";
import webpackClientConfig from "config/webpack/webpack-vue-client-cfg.js";

// Constants
const port = process.env.NODE_PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const VUE_SSR_BUILD_DIR = _resolve(__dirname, "../../build/");
const VUE_TEMPLATE_DIR = process.env.VUE_TEMPLATE_DIR
  ? _resolve(process.env.VUE_TEMPLATE_DIR)
  : null;
const VUE_COMPONENT_DIR = process.env.VUE_COMPONENT_DIR
  ? _resolve(process.env.VUE_COMPONENT_DIR)
  : _exit(
      "Component directory not defined - please set VUE_COMPONENT_DIR environment variable"
    );
const VUE_ROUTES_FILE = process.env.VUE_ROUTES_FILE
  ? _resolve(process.env.VUE_ROUTES_FILE)
  : _exit(
      "Routes file must be specified - please set VUE_ROUTES_FILE environment variable"
    );
const VUE_CLIENT_BUILD_DIR = process.env.VUE_CLIENT_BUILD_DIR
  ? _resolve(process.env.VUE_CLIENT_BUILD_DIR)
  : VUE_SSR_BUILD_DIR;
const VUE_CLIENT_BUILD_DIR_PUBLIC_PATH = process.env
  .VUE_CLIENT_BUILD_DIR_PUBLIC_PATH
  ? process.env.VUE_CLIENT_BUILD_DIR_PUBLIC_PATH
  : "/";

// If we're doing templates (aka layouts), synchronously load them into an in-memory array.
// Since templates are almost always going to be super lightweight, for now synchronous + in-memory is fine.
const templateFiles = [];

if (VUE_TEMPLATE_DIR) {
  fs.readdirSync(VUE_TEMPLATE_DIR).forEach(file => {
    let name = parse(file).name + parse(file).ext;
    let filepath = _resolve(VUE_TEMPLATE_DIR, file);
    let stat = fs.statSync(filepath);
    let isFile = stat.isFile();
    if (isFile) {
      let body = fs.readFileSync(filepath, "utf-8");
      templateFiles.push({ name, body });
    }
  });
}

const webpackCommonVariableConfig = {
  mode: NODE_ENV,
  output: {
    path: VUE_SSR_BUILD_DIR,
    publicPath: VUE_CLIENT_BUILD_DIR_PUBLIC_PATH
  },
  resolve: {
    alias: {
      components: VUE_COMPONENT_DIR,
      vueRoutes$: VUE_ROUTES_FILE
    }
  }
};

// Modify client config for hot reloading in dev
if (NODE_ENV == "development") {
  webpackClientConfig.entry.client = [
    `webpack-hot-middleware/client?path=http://localhost:${port}/vue-hmr/hmr?name=vue-client`,
    webpackClientConfig.entry.client
  ];
  webpackClientConfig.plugins.push(
    new webpack.HotModuleReplacementPlugin(),
    new webpack.NoEmitOnErrorsPlugin()
  );
}

// merge common variables with core webpack configs
const webpackCompiler = webpack([
  merge(webpackCommonVariableConfig, webpackClientConfig),
  merge(webpackCommonVariableConfig, webpackServerConfig)
]);

// Function to get the middleware instance only in development
// Otherwise there's a double webpack compilation in production
const webpackDevMiddlewareInstance = (env => {
  if (env == "development") {
    return webpackDevMiddleware(webpackCompiler, {
      publicPath: webpackClientConfig.output.publicPath,
      stats: "none",
      writeToDisk: true
    });
  } else {
    return false;
  }
})(NODE_ENV);

// Define compiled assets
let clientManifest;
let serverBundle;

const getSSRBundle = () => {
  return { serverBundle, clientManifest };
};

// To be run when compiling completes
webpackCompiler.hooks.done.tap({ name: "Done" }, stats => {
  // stats.hasErrors() == a compilation error, so log output to console.error & exit
  if (stats.hasErrors()) {
    console.error(
      stats.toString({
        chunks: false,
        colors: true,
        modules: false
      })
    );
    process.exit(1);
  }

  // Otherwise logs the stats to console.info...
  console.log(
    stats.toString({
      chunks: false,
      colors: true,
      modules: false
    })
  );

  const assetFS =
    NODE_ENV == "development" ? webpackDevMiddlewareInstance.fileSystem : fs;
  serverBundle = JSON.parse(
    assetFS.readFileSync(
      _resolve(VUE_SSR_BUILD_DIR, "vue-ssr-server-bundle.json"),
      "utf-8"
    )
  );
  clientManifest = JSON.parse(
    assetFS.readFileSync(
      _resolve(VUE_SSR_BUILD_DIR, "vue-ssr-client-manifest.json"),
      "utf-8"
    )
  );

  // Webpack doesn't support multiple output within a single config file, and we need to put the client JSON
  // bundle in the server dist directory, but the client JS file in the calling webserver's output directory
  // so we do this with a symlink.  This feels hack-y, but for now it'll have to do.

  try {
    console.log(
      `creating symlink from ${_resolve(VUE_SSR_BUILD_DIR)} to ${_resolve(
        VUE_CLIENT_BUILD_DIR
      )}`
    );
    fs.symlinkSync(_resolve(VUE_SSR_BUILD_DIR), _resolve(VUE_CLIENT_BUILD_DIR));
  } catch (e) {
    if (e.code == "EEXIST") {
      console.log("[node] Symlink already exists - moving on...");
    } else {
      throw e;
    }
  }

  console.log("[node] Webpack compilation complete.");
});

// Our actual render workhorse - this is called on each request to do the actual SSR.
// Takes a serverBundle & clientManifest, which come from webpack's memory FS in development
// and will live on disk (pre-built) in production

const doRender = () => {
  return (req, res) => {
    // We're using the WHATWG URL standard since it's a mostly-standard, but that binds us to Node 8+
    let url = new URL(`http://localhost:${port}${req.url}`);
    let pathname = url.pathname;
    let templateRequested = url.searchParams.get("template");
    let templateResult = templateFiles.find(
      file => file.name == templateRequested
    );
    let template = templateResult ? templateResult.body : null;

    console.log(`[node] SSR request received - ${req.url}`);
    console.log(
      `[node] type: ${req.method}, path: ${pathname}, template: ${templateRequested}`
    );

    let { serverBundle, clientManifest } = getSSRBundle();

    // This is the core vue-ssr method that builds the SSR.
    // See https://ssr.vuejs.org/guide/bundle-renderer.html
    let renderer = createBundleRenderer(serverBundle, {
      template,
      clientManifest,
      runInNewContext: false,
      shouldPreload: (file, type) => {
        if (type === "script" || type === "style") {
          return true;
        }
        if (type === "font") {
          return /\.otf$/.test(file);
        }
      }
    });

    // We use the HTTP body to pass a JSON object containing the crystal-rendered parameters.
    // Probably a better/more robust way to do this, but it's simple and works for now.
    let body = [];
    let celestiteContext = {};

    req
      .on("error", err => {
        console.log(err);
      })
      .on("data", chunk => {
        body.push(chunk);
      })
      .on("end", async () => {
        let rawBody = Buffer.concat(body).toString();

        if (rawBody) {
          Object.assign(celestiteContext, JSON.parse(rawBody));
        }

        let context = { pathname, celestiteContext };

        console.log(`[node] Context going into render:`);
        console.log(context);

        try {
          let html = await renderer.renderToString(context);
          res.end(html);
        } catch (err) {
          res.write(`error: ${err}`);
        }
      });
  };
};

// Fire it all up!
let app;

if (NODE_ENV == "development") {
  app = express();
  app.disable("x-powered-by");
  app.use(webpackDevMiddlewareInstance);
  app.use(
    webpackHotMiddleware(webpackCompiler, {
      path: "/vue-hmr/hmr"
    })
  );
  webpackDevMiddlewareInstance.waitUntilValid(() => {
    console.log("Package is in a valid state");
  });
  app.use("*", doRender());
} else {
  app = {};
  webpackCompiler.run();
}

app.timeout = 0;
app.keepAliveTimeout = 0;

const server = new Server(app);

if (!(NODE_ENV == "development")) {
  server.on("request", doRender(serverBundle, clientManifest));
}

server.listen(port, err => {
  if (err) throw err;
  console.log(
    `[node] Vue SSR renderer listening in ${NODE_ENV} mode on port ${port}`
  );
});

// handle exceptions gracefully so our client doesn't die of loneliness
process.on("uncaughtException", err => {
  console.error(`[node] Error w/ node process: ${err}`);
  server.close(() => process.exit(1));
});
