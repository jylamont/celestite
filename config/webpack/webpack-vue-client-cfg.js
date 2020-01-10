const webpack = require("webpack");
const merge = require("webpack-merge");
const path = require("path");
const baseConfig = require("./webpack-base-cfg.js");
const VueSSRClientPlugin = require("vue-server-renderer/client-plugin");

module.exports = merge(baseConfig, {
  name: "vue-client",
  target: "web",
  entry: {
    client: "vue-scripts/entry-client.js"
  },
  output: {
    filename: "cvue.[name].[hash].js"
  },
  plugins: [new VueSSRClientPlugin()]
});
