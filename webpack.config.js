const path = require('path');
const webpack = require('webpack');

// Short commit SHA baked in at build time (set by CI), so a sideloaded beta
// build can be identified from inside the extension itself even though
// package.json's version stays the same across beta rounds. 'dev' for local
// builds where BUILD_SHA isn't set.
const buildSha = (process.env.BUILD_SHA || 'dev').slice(0, 7);

module.exports = {
  mode: 'none',
  target: 'node',
  entry: {
    extension: './src/extension.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.BUILD_SHA': JSON.stringify(buildSha)
    })
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  }
};
