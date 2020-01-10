const merge = require("webpack-merge");
const path = require("path");
const nodeExternals = require("webpack-node-externals");
const baseConfig = require("./webpack-base-cfg.js");
const VueSSRServerPlugin = require("vue-server-renderer/server-plugin");

module.exports = merge(baseConfig, {
  name: "vue-server",
  entry: "vue-scripts/entry-server.js",
  target: "node",
  devtool: "source-map",
  output: {
    libraryTarget: "commonjs2"
  },
  externals: nodeExternals({
    whitelist: [/\.css$/, /\.vue$/]
  }),
  plugins: [new VueSSRServerPlugin()]
});
